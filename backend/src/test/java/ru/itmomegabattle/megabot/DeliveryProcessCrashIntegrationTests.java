package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import ru.itmomegabattle.megabot.notifications.*;
import tools.jackson.databind.ObjectMapper;

/** Kill only JVMs created here; database and fake transport are confined to this test. */
@Import(TestcontainersConfiguration.class)
@SpringBootTest(properties="spring.datasource.hikari.maximum-pool-size=2")
@ActiveProfiles("test") @Testcontainers(disabledWithoutDocker=true)
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
@Timeout(180)
class DeliveryProcessCrashIntegrationTests {
    @Autowired PostgreSQLContainer postgres;
    @Autowired JdbcTemplate jdbc;
    @Autowired DeliveryQueue queue;
    @Autowired DeliveryQuota quota;
    @Autowired ObjectMapper json;
    @Autowired PlatformTransactionManager manager;
    @TempDir Path temporary;
    String id;

    @BeforeEach void prepare() {
        jdbc.execute("truncate users,broadcasts,notification_deliveries,delivery_rate_limits cascade");
        jdbc.update("insert into users(id,telegram_id,username,real_name,role,registered) values ('a',5100,'author','Автор','organizer',true),('r',5101,'recipient','Адресат','organizer',true)");
        id=delivery(false);
    }
    String delivery(boolean future) {
        return new TransactionTemplate(manager).execute(s->{
            var b="crash_"+UUID.randomUUID(); var t="target_"+UUID.randomUUID();
            var now=jdbc.queryForObject("select clock_timestamp()",java.sql.Timestamp.class).toInstant();
            var due=now.plusSeconds(future?3600:-1);
            jdbc.update("insert into broadcasts(id,author_id,content,scheduled_at,misfire_policy,expires_at,status) values (?,'a','Текст',?,'send_within_grace',?,'scheduled')",b,java.sql.Timestamp.from(due),java.sql.Timestamp.from(due.plusSeconds(900)));
            jdbc.update("insert into broadcast_targets(id,broadcast_id,revision,target_key,recipient_id,chat_id) values (?,?,1,'user:r','r',5101)",t,b);
            var result=queue.enqueue(new DeliveryQueue.NewDelivery(b,b,"broadcast","r",5101,null,"{\"text\":\"Синтетическая проверка crash\"}",true,due,due,due.plusSeconds(900)));
            jdbc.update("update notification_deliveries set broadcast_target_id=? where id=?",t,result);
            return result;
        });
    }
    String status() { return jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,id); }
    void expireLease() {
        // Only the disposable row's deadline advances; the JVM crash itself is real.
        jdbc.update("update notification_deliveries set leased_until=clock_timestamp()-interval '1 second' where id=?",id);
    }
    String child(String mode,boolean crash) throws Exception {
        var log=temporary.resolve(UUID.randomUUID()+".log");
        var classpath=System.getProperty("surefire.test.class.path",System.getProperty("java.class.path"));
        var args=temporary.resolve(UUID.randomUUID()+".args");
        // Java's native argfile avoids Windows command-line limits; no shell is involved.
        Files.writeString(args,"-cp\n\""+classpath.replace("\\","\\\\").replace("\"","\\\"")+"\"\n");
        var java=Path.of(System.getProperty("java.home"),"bin",System.getProperty("os.name").startsWith("Windows")?"java.exe":"java");
        var builder=new ProcessBuilder(java.toString(),"-Xmx256m","@"+args,WorkerProcess.class.getName(),mode,
                "--spring.datasource.url="+postgres.getJdbcUrl(),"--spring.datasource.username="+postgres.getUsername(),
                "--spring.datasource.password="+postgres.getPassword());
        // Never inherit tokens, production DB configuration or JVM option injection.
        builder.environment().keySet().removeIf(key->!Set.of("SystemRoot","WINDIR","TEMP","TMP","PATH").contains(key));
        var process=builder.redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(90);
            String output="";
            while(process.isAlive() && !(output=Files.readString(log)).contains("CRASH_READY") && System.nanoTime()<deadline)
                Thread.sleep(50);
            output=Files.readString(log);
            if(crash) {
                assertThat(output).as("child reached durable barrier: %s",output).contains("CRASH_READY");
                process.destroyForcibly();
                assertThat(process.waitFor(10,TimeUnit.SECONDS)).isTrue();
                assertThat(process.exitValue()).isNotZero();
            } else {
                assertThat(process.waitFor(10,TimeUnit.SECONDS)).as("child output: %s",output).isTrue();
                assertThat(process.exitValue()).as("child output: %s",Files.readString(log)).isZero();
            }
            return Files.readString(log);
        } finally {
            if(process.isAlive()) { process.destroyForcibly();process.waitFor(10,TimeUnit.SECONDS); }
        }
    }
    @Test void killAfterClaimRecoversUnstartedWorkAndRejectsDeadWorkerToken() throws Exception {
        child("claimed",true);
        assertThat(status()).isEqualTo("claimed");
        var old=jdbc.queryForObject("select lease_token from notification_deliveries where id=?",String.class,id);
        assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
        expireLease();assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
        assertThat(queue.start(id,old)).isFalse();
        assertThat(queue.finish(id,old,DeliveryQueue.Result.sent(99))).isFalse();
        assertThat(child("deliver",false)).contains("FAKE_ACCEPTED","PROCESSED true");
        assertThat(status()).isEqualTo("sent");
        assertThat(jdbc.queryForObject("select attempts from notification_deliveries where id=?",Integer.class,id)).isEqualTo(1);
        assertThat(child("deliver",false)).contains("PROCESSED false").doesNotContain("FAKE_ACCEPTED");
    }
    @Test void killAfterFakeAcceptanceLeavesUnknownAndDoesNotRepeatOtherSuccessfulTarget() throws Exception {
        var successful=id;
        var worker=new BroadcastDispatcher(queue,quota,message->TelegramTransport.Outcome.sent(91),json,"12345",DeliveryQuota.Limits.defaults());
        assertThat(worker.dispatchOne()).isTrue();
        id=delivery(false);jdbc.execute("truncate delivery_rate_limits");
        assertThat(child("accepted",true)).contains("FAKE_ACCEPTED");
        assertThat(status()).isEqualTo("sending");
        expireLease();assertThat(queue.recoverExpiredLeases()).isEqualTo(1);
        assertThat(status()).isEqualTo("unknown");
        assertThat(jdbc.queryForObject("select result_status from delivery_attempts where delivery_id=?",String.class,id)).isEqualTo("unknown");
        assertThat(child("deliver",false)).contains("PROCESSED false").doesNotContain("FAKE_ACCEPTED");
        assertThat(jdbc.queryForObject("select status from notification_deliveries where id=?",String.class,successful)).isEqualTo("sent");
        assertThat(jdbc.queryForObject("select telegram_message_id from notification_deliveries where id=?",Long.class,successful)).isEqualTo(91);
    }
    @Test void restartBeforeDuePreservesFutureIntentWithoutEarlySend() throws Exception {
        jdbc.execute("truncate broadcasts,notification_deliveries,delivery_rate_limits cascade");id=delivery(true);
        var intended=jdbc.queryForObject("select intended_at from notification_deliveries where id=?",java.sql.Timestamp.class,id);
        child("future",true);
        assertThat(child("deliver",false)).contains("PROCESSED false").doesNotContain("FAKE_ACCEPTED");
        assertThat(status()).isEqualTo("planned");
        assertThat(jdbc.queryForObject("select intended_at from notification_deliveries where id=?",java.sql.Timestamp.class,id)).isEqualTo(intended);
        assertThat(jdbc.queryForObject("select count(*) from delivery_attempts",Integer.class)).isZero();
    }

    /** Child uses real Spring queue/transactions with live delivery explicitly disabled. */
    public static class WorkerProcess {
        public static void main(String[] args) throws Exception {
            var properties=new ArrayList<>(Arrays.asList(args).subList(1,args.length));
            properties.addAll(List.of("--spring.profiles.active=test","--server.port=0","--server.address=127.0.0.1",
                    "--megabot.delivery.enabled=false","--megabot.integrations.telegram.mode=fake","--megabot.integrations.google.mode=fake",
                    "--megabot.auth.telegram.bot-token=","--spring.datasource.hikari.maximum-pool-size=2","--logging.level.root=WARN"));
            try(var context=SpringApplication.run(MegaBotApplication.class,properties.toArray(String[]::new))) {
                var queue=context.getBean(DeliveryQueue.class);
                if("claimed".equals(args[0])) {
                    if(queue.claimBroadcasts(1,Duration.ofSeconds(30),"12345").size()!=1)throw new IllegalStateException("missing_claim");
                    barrier();
                } else {
                    var worker=new BroadcastDispatcher(queue,context.getBean(DeliveryQuota.class),message->{
                        if(message.chatId()!=5101)throw new IllegalStateException("outside_synthetic_recipient");
                        System.out.println("FAKE_ACCEPTED");System.out.flush();
                        if("accepted".equals(args[0]))barrier();
                        return TelegramTransport.Outcome.sent(92);
                    },context.getBean(ObjectMapper.class),"12345",DeliveryQuota.Limits.defaults());
                    boolean processed=worker.dispatchOne();
                    System.out.println("PROCESSED "+processed);
                    if("future".equals(args[0])) { if(processed)throw new IllegalStateException("early_send");barrier(); }
                }
            }
        }
        static void barrier() {
            System.out.println("CRASH_READY");System.out.flush();
            try { System.in.read(); }catch(java.io.IOException failure) { throw new IllegalStateException(failure); }
        }
    }
}
