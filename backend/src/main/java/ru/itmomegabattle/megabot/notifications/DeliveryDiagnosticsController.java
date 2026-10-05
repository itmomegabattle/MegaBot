package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.itmomegabattle.megabot.common.ApiException;

/** On-demand, aggregate-only diagnostics. No payload, identities or raw provider errors. */
@RestController
@PreAuthorize("hasRole('ADMIN')")
class DeliveryDiagnosticsController {
	private final JdbcClient jdbc;
	private final DataSource source;
	private final ObjectProvider<BroadcastDispatcher> worker;
	DeliveryDiagnosticsController(JdbcClient jdbc,DataSource source,ObjectProvider<BroadcastDispatcher> worker) { this.jdbc=jdbc;this.source=source;this.worker=worker; }

	@GetMapping("/api/v1/admin/delivery-diagnostics")
	@Transactional(readOnly=true)
	ResponseEntity<Snapshot> snapshot() {
		try {
			jdbc.sql("select set_config('statement_timeout','3000',true)").query(String.class).single();
			// ponytail: on-demand aggregate scan bounded to 3s; use indexed rollups if measured volume requires them.
			var snapshot=jdbc.sql("""
					with instant as (select statement_timestamp() as at),
					queue as (
					 select count(*) as total,
					 count(*) filter(where status='planned') as planned,count(*) filter(where status='retry') as retry,
					 count(*) filter(where status='claimed') as claimed,count(*) filter(where status='sending') as sending,
					 count(*) filter(where status='sent') as sent,count(*) filter(where status='failed') as failed,
					 count(*) filter(where status='unknown') as unknown,count(*) filter(where status='cancelled') as cancelled,
					 count(*) filter(where status='expired') as expired,
					 count(*) filter(where status in ('planned','retry') and not cancel_requested and attempts<8
					 and intended_at<=at and available_at<=at and (expires_at is null or expires_at>at)) as due,
					 max(extract(epoch from at-available_at)) filter(where status in ('planned','retry') and not cancel_requested and attempts<8
					 and intended_at<=at and available_at<=at and (expires_at is null or expires_at>at))::double precision as oldest,
					 count(*) filter(where status in ('claimed','sending') and leased_until<=at) as stale_leases
					 from notification_deliveries cross join instant
					), samples as (
					 select a.attempt_number,a.result_status,
					 extract(epoch from a.started_at-d.intended_at)*1000 as lateness,
					 extract(epoch from a.finished_at-a.started_at)*1000 as duration
					 from delivery_attempts a join notification_deliveries d on d.id=a.delivery_id cross join instant
					 where a.started_at>=at-interval '24 hours' and a.started_at<=at
					), timings as (
					 select count(*) as attempt_count,count(*) filter(where attempt_number=1) as first_count,
					 count(*) filter(where lateness<0) as early_count,
					 percentile_cont(0.5) within group(order by lateness) filter(where attempt_number=1) as p50,
					 percentile_cont(0.95) within group(order by lateness) filter(where attempt_number=1) as p95,
					 percentile_cont(0.99) within group(order by lateness) filter(where attempt_number=1) as p99,
					 max(lateness) filter(where attempt_number=1)::double precision as max_lateness,
					 count(duration) filter(where result_status<>'sending') as finished_count,
					 percentile_cont(0.95) within group(order by duration) filter(where result_status<>'sending') as duration_p95
					 from samples
					)
					select * from instant cross join queue cross join timings
					""").query((r,i)->new Snapshot(r.getTimestamp("at").toInstant(),24,
						new Queue(r.getLong("total"),r.getLong("planned"),r.getLong("retry"),r.getLong("claimed"),r.getLong("sending"),r.getLong("sent"),r.getLong("failed"),r.getLong("unknown"),r.getLong("cancelled"),r.getLong("expired"),r.getLong("due"),r.getObject("oldest",Double.class),r.getLong("stale_leases")),
						new Timings(r.getLong("attempt_count"),r.getLong("first_count"),r.getLong("early_count"),r.getObject("p50",Double.class),r.getObject("p95",Double.class),r.getObject("p99",Double.class),r.getObject("max_lateness",Double.class),r.getLong("finished_count"),r.getObject("duration_p95",Double.class)),pool(),workerStatus(),List.of("ntpClockOffset","devicePushLatency"))).single();
			return ResponseEntity.ok().header("Cache-Control","no-store").body(snapshot);
		}catch(DataAccessException unavailable) {
			throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,"delivery_diagnostics_unavailable","Диагностика очереди временно недоступна");
		}
	}
	private Pool pool() {
		if(source instanceof HikariDataSource hikari && hikari.getHikariPoolMXBean()!=null) {
			var p=hikari.getHikariPoolMXBean();
			return new Pool(p.getActiveConnections(),p.getIdleConnections(),p.getTotalConnections(),p.getThreadsAwaitingConnection(),hikari.getMaximumPoolSize());
		}return null;
	}
	private BroadcastDispatcher.WorkerStatus workerStatus() {
		var current=worker.getIfAvailable();
		return current==null?new BroadcastDispatcher.WorkerStatus("disabled",false,null,null,null,null,0):current.workerStatus();
	}
	record Snapshot(Instant databaseNow,int windowHours,Queue queue,Timings timings,Pool databasePool,BroadcastDispatcher.WorkerStatus worker,List<String> notMeasured) {
		// Derived from this same snapshot; no second query or notification side effects.
		@com.fasterxml.jackson.annotation.JsonProperty
		public List<Signal> signals() {
			var signals=new ArrayList<Signal>();
			if(worker.state().equals("stalled")) signals.add(new Signal("worker_stalled","critical"));
			if(worker.state().equals("clock_uncertain")) signals.add(new Signal("worker_clock_uncertain","warning"));
			if(worker.state().equals("error")) signals.add(new Signal("worker_error","warning"));
			if(queue.due()>0 && queue.oldestDueAgeSeconds()!=null && queue.oldestDueAgeSeconds()>10)
				signals.add(new Signal("due_backlog_quota_unverified","warning"));
			if(queue.staleLeases()>0) signals.add(new Signal("stale_leases","warning"));
			if(queue.unknown()>0) signals.add(new Signal("unknown_outcomes","warning"));
			if(timings.earlyAttempts()>0) signals.add(new Signal("early_attempts","critical"));
			if(databasePool!=null && databasePool.awaiting()>0) signals.add(new Signal("database_pool_waiters","warning"));
			return List.copyOf(signals);
		}
	}
	record Signal(String code,String severity) {}
	record Queue(long total,long planned,long retry,long claimed,long sending,long sent,long failed,long unknown,long cancelled,long expired,long due,Double oldestDueAgeSeconds,long staleLeases) {}
	record Timings(long attempts,long firstAttempts,long earlyAttempts,Double firstStartLatenessP50Ms,Double firstStartLatenessP95Ms,Double firstStartLatenessP99Ms,Double firstStartLatenessMaxMs,long finishedAttempts,Double attemptDurationP95Ms) {}
	record Pool(int active,int idle,int total,int awaiting,int max) {}
}
