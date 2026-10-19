package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

/** Explicit slow measurement: -Dtest=DeliveryLoadIT test. Never calls Telegram. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
@Timeout(value=180,unit=TimeUnit.SECONDS)
class DeliveryLoadIT {

	@Autowired DeliveryQueue queue;
	@Autowired DeliveryQuota quota;
	@Autowired JdbcTemplate jdbc;
	@Autowired ObjectMapper json;
	@Autowired PlatformTransactionManager manager;
	AtomicInteger calls;

	@BeforeEach void prepare() {
		jdbc.execute("truncate users,broadcasts,notification_deliveries,delivery_rate_limits cascade");
		calls=new AtomicInteger();
	}

	@Test void pacedThousandMeasuresEngineWithDefaultQuota() { measure("paced-engine",1000,60,false); }
	@Test void burstThousandMeasuresBacklogWithDefaultQuota() { measure("burst-engine",1000,0,false); }
	@Test void lifecycleWakeupDrainsThousandWithDefaultQuota() { measure("scheduled-burst",1000,0,true); }
	@Test @Timeout(value=780,unit=TimeUnit.SECONDS)
	void lifecyclePacedThousandMeasuresLatenessWithoutQuotaDeferral() { measure("scheduled-paced",1000,600,true); }

	private void measure(String scenario,int count,int spacingMs,boolean scheduled) {
		seed(count,spacingMs);
		var recipients=java.util.concurrent.ConcurrentHashMap.<Long>newKeySet();
		var worker=new BroadcastDispatcher(queue,quota,message->{
			assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
			assertThat(message.silent()).isTrue();
			assertThat(recipients.add(message.chatId())).as("recipient must not be sent twice").isTrue();
			return TelegramTransport.Outcome.sent(calls.incrementAndGet());
		},json,"12345",DeliveryQuota.Limits.defaults());
		long started=System.nanoTime(),deadline=started+Duration.ofMillis((long)count*spacingMs).plusSeconds(150).toNanos();
		org.springframework.context.annotation.AnnotationConfigApplicationContext scheduler=null;
		if(scheduled) {
			scheduler=new org.springframework.context.annotation.AnnotationConfigApplicationContext();
			scheduler.registerBean(org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor.class);
			scheduler.registerBean(BroadcastDispatcher.class,()->worker);
			scheduler.refresh();
		}
		try {
			while(calls.get()<count && System.nanoTime()<deadline) {
				if(!scheduled)worker.dispatchOne();
				LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(scheduled?20:5));
				if(Thread.currentThread().isInterrupted())throw new AssertionError("load_measurement_interrupted");
			}
		}finally { if(scheduler!=null)scheduler.close(); }
		assertThat(calls).hasValue(count);
		assertThat(recipients).hasSize(count);
		assertThat(jdbc.queryForObject("select count(*) from notification_deliveries where status='sent' and attempts=1 and telegram_message_id is not null",Integer.class)).isEqualTo(count);
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isEqualTo(count);
		assertThat(jdbc.queryForObject("select count(*) from delivery_attempts a join notification_deliveries d on d.id=a.delivery_id where a.started_at<d.intended_at",Integer.class)).isZero();
		assertThat(queue.claimBroadcasts(100,Duration.ofSeconds(30))).isEmpty();
		var timings=jdbc.queryForMap("""
				select percentile_cont(0.50) within group(order by ms) as p50,
				percentile_cont(0.95) within group(order by ms) as p95,
				percentile_cont(0.99) within group(order by ms) as p99,max(ms) as maximum,
				min(extract(epoch from sent_at-intended_at)*1000) as first_completion,
				max(extract(epoch from sent_at-intended_at)*1000) as last_completion
				from (select d.*,extract(epoch from a.started_at-d.intended_at)*1000 as ms
				from notification_deliveries d join delivery_attempts a on a.delivery_id=d.id where a.attempt_number=1) samples
				""");
		var deferred=jdbc.queryForObject("select count(*) from notification_deliveries where available_at>initial_available_at",Integer.class);
		System.out.printf(java.util.Locale.ROOT,
				"DELIVERY_LOAD scenario=%s samples=%d elapsed_ms=%.0f p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f max_ms=%.3f first_completion_ms=%s last_completion_ms=%s quota_deferred=%d calls=%d%n",
				scenario,count,(System.nanoTime()-started)/1_000_000.0,timings.get("p50"),timings.get("p95"),timings.get("p99"),timings.get("maximum"),timings.get("first_completion"),timings.get("last_completion"),deferred,calls.get());
		if(scheduled && spacingMs>0) {
			assertThat(deferred).as("paced scheduler must be measured without quota deferral").isZero();
			assertThat(((Number)timings.get("p95")).doubleValue()).as("local scheduler p95 milliseconds").isLessThanOrEqualTo(2000);
			assertThat(((Number)timings.get("p99")).doubleValue()).as("local scheduler p99 milliseconds").isLessThanOrEqualTo(5000);
		}
	}

	private void seed(int count,int spacingMs) {
		new TransactionTemplate(manager).executeWithoutResult(status->{
			jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) select 'load_'||i,100000+i,'load_'||i,'Synthetic','organizer',true from generate_series(0,?) i",count);
			var due=Instant.now().plusSeconds(10);
			jdbc.update("insert into broadcasts(id,author_id,content,scheduled_at,misfire_policy,expires_at,status) values ('load','load_0','Synthetic',?,'send_within_grace',?,'scheduled')",java.sql.Timestamp.from(due),java.sql.Timestamp.from(due.plusSeconds(900)));
			jdbc.update("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id) select 'target_'||i,'load',1,'user:load_'||i,'load_'||i,100000+i from generate_series(1,?) i",count);
			for(int i=1;i<=count;i++) {
				var id=queue.enqueue(new DeliveryQueue.NewDelivery("load","load:"+i,"broadcast","load_"+i,100000+i,null,"{\"text\":\"Synthetic\"}",true,due,due,due.plusSeconds(900)));
				jdbc.update("update notification_deliveries set broadcast_target_id=? where id=?","target_"+i,id);
			}
			// Fixture schedules start after insertion, so preparation time is not counted as dispatch lag.
			jdbc.update("""
					update notification_deliveries set intended_at=statement_timestamp()+interval '1 second'+(chat_id-100001)*?*interval '1 millisecond',
					available_at=statement_timestamp()+interval '1 second'+(chat_id-100001)*?*interval '1 millisecond',
					initial_available_at=statement_timestamp()+interval '1 second'+(chat_id-100001)*?*interval '1 millisecond',
					expires_at=statement_timestamp()+interval '15 minutes'
					""",spacingMs,spacingMs,spacingMs);
		});
	}
}
