package ru.itmomegabattle.megabot.notifications;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;

/** Bounded single HTTP worker. Scheduler only wakes it; PostgreSQL owns schedules/quotas. */
public final class BroadcastDispatcher implements SmartLifecycle {
	private final DeliveryQueue queue;private final DeliveryQuota quota;private final TelegramTransport transport;
	private final ObjectMapper json;private final String bot;private final DeliveryQuota.Limits limits;
	private final ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders;
	private final ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual;
	private final ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings;
	private final ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability;
	private final BirthdayReminderPlanner birthdays;
	private final BroadcastExpiryPlanner expirations;
	private final ru.itmomegabattle.megabot.telegram.TelegramReplyPlanner replies;
	private final Clock clock;
	private volatile Instant lifecycleStartedAt;
	private volatile Cycle cycle=new Cycle(null,null,null,0);
	private final AtomicBoolean running=new AtomicBoolean(),busy=new AtomicBoolean();
	private ScheduledExecutorService heartbeats;private ExecutorService sender;
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits) {
		this(queue,quota,transport,json,bot,limits,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders) {
		this(queue,quota,transport,json,bot,limits,reminders,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,Clock.systemUTC());
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,clock,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,clock,meetings,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings,ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,clock,meetings,availability,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings,ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability,BirthdayReminderPlanner birthdays) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,clock,meetings,availability,birthdays,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings,ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability,BirthdayReminderPlanner birthdays,BroadcastExpiryPlanner expirations) {
		this(queue,quota,transport,json,bot,limits,reminders,manual,clock,meetings,availability,birthdays,expirations,null);
	}
	public BroadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,TelegramTransport transport,ObjectMapper json,String bot,DeliveryQuota.Limits limits,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings,ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability,BirthdayReminderPlanner birthdays,BroadcastExpiryPlanner expirations,ru.itmomegabattle.megabot.telegram.TelegramReplyPlanner replies) {
		this.queue=queue;this.quota=quota;this.transport=transport;this.json=json;this.bot=bot;this.limits=limits;
		this.reminders=reminders;
		this.manual=manual;
		this.clock=clock;
		this.meetings=meetings;
		this.availability=availability;
		this.birthdays=birthdays;
		this.expirations=expirations;
		this.replies=replies;
	}
	@Override public synchronized void start() {
		if(!running.compareAndSet(false,true))return;
		lifecycleStartedAt=clock.instant();cycle=new Cycle(null,null,null,0);
		sender=Executors.newSingleThreadExecutor(r->new Thread(r,"broadcast-http"));
		heartbeats=Executors.newSingleThreadScheduledExecutor(r->new Thread(r,"broadcast-heartbeat"));
	}
	@Scheduled(fixedDelay=500)
	public synchronized void wakeup() {
		if(running.get() && busy.compareAndSet(false,true))sender.submit(()->{
			try {
				// ponytail: one worker, bounded drain; no batch leases waiting for network.
				long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(1);
				for(int n=0;n<100 && running.get() && !Thread.currentThread().isInterrupted() && System.nanoTime()<deadline;n++) {
					if(!dispatchOne())break;
					java.util.concurrent.locks.LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
				}
			}catch(RuntimeException ignored) { /* No secret-bearing exceptions logged; lease recovery owns interrupted work. */ }
			finally { busy.set(false); }
		});
	}
	/** Callable by isolated integration tests; production invocation is bounded by the lifecycle worker. */
	public boolean dispatchOne() {
		if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("dispatcher_requires_no_transaction");
		var previous=cycle;var started=clock.instant();
		cycle=new Cycle(started,previous.completed(),previous.outcome(),previous.failures());
		try {
			boolean processed=dispatchCycle();
			cycle=new Cycle(started,clock.instant(),processed?"processed":"idle",0);
			return processed;
		}catch(RuntimeException failure) {
			cycle=new Cycle(started,clock.instant(),"error",previous.failures()+1);
			throw failure; // The scheduler contains it; diagnostics retain no exception text or credentials.
		}
	}
	private boolean dispatchCycle() {
		queue.recoverExpiredLeases();queue.expirePending();
		if(expirations!=null)expirations.materialize(20);
		if(reminders!=null)reminders.materialize(20);
		if(manual!=null)manual.materialize(20);
		if(meetings!=null)meetings.materialize(20,bot);
		if(availability!=null)availability.materialize();
		if(birthdays!=null)birthdays.materialize();
		if(replies!=null)replies.materialize(20,bot);
		var leases=reminders==null && manual==null && meetings==null && availability==null && birthdays==null && replies==null?queue.claimBroadcasts(1,Duration.ofSeconds(30),bot):queue.claimSupported(1,Duration.ofSeconds(30),bot);if(leases.isEmpty())return false;
		var lease=leases.getFirst();TelegramTransport.Message message=null;TelegramTransport.Edit edit=null;TelegramTransport.Acknowledgement ack=null;TelegramTransport.Deletion deletion=null;boolean meetingMarkup=false;
		try {
			var root=json.readTree(lease.payload());var text=root.path("text");
			var operation=TelegramTransport.operation(root);
			if(!operation.equals("delete") && !text.isString())throw new IllegalArgumentException("invalid_broadcast_payload");
			if(!operation.equals("send") && (lease.threadId()!=null || lease.silent() || !operation.equals("delete") && lease.commandReplyOutboxId()==null))throw new IllegalArgumentException("invalid_operation_source");
			if(operation.equals("delete"))deletion=TelegramTransport.deletionFrom(lease.chatId(),root);
			else if(operation.equals("ack"))ack=TelegramTransport.ackFrom(lease.chatId(),root);
			else {
				meetingMarkup=root.has("replyMarkup") && lease.commandReplyOutboxId()==null && queue.meetingMarkupAllowed(lease.id(),lease.token(),bot);
				if(root.has("replyMarkup")!=(lease.commandReplyOutboxId()!=null || meetingMarkup))throw new IllegalArgumentException("invalid_keyboard_source");
				if(operation.equals("edit"))edit=TelegramTransport.editFrom(lease.chatId(),root);
				else message=TelegramTransport.Message.withMarkup(lease.chatId(),lease.threadId(),text.asText(),lease.silent(),root.get("replyMarkup"));
			}
		}catch(RuntimeException invalid) {
			if(queue.start(lease.id(),lease.token()))queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.failed("invalid_delivery_payload"));
			return true;
		}
		var decision=quota.reserve(bot,lease.chatId(),limits);
		if(!decision.allowed()) { queue.deferBeforeStart(lease.id(),lease.token(),decision.availableAt());return true; }
		if(!queue.start(lease.id(),lease.token()))return true;
		var attempt=queue.attemptNumber(lease.id(),lease.token());if(attempt==0)return true;
		var renewal=heartbeats==null?null:heartbeats.scheduleWithFixedDelay(()->{
			try { queue.heartbeat(lease.id(),lease.token(),Duration.ofSeconds(30)); }catch(RuntimeException ignored) { /* Fail closed through token/lease gate. */ }
		},5,5,TimeUnit.SECONDS);
		try {
			// Last token check immediately before network; no HTTP inside a domain/queue transaction.
			if(!queue.heartbeat(lease.id(),lease.token(),Duration.ofSeconds(30)))return true;
			if(lease.birthdayTargetId()!=null) {
				var text=queue.birthdayTextForSending(lease.id(),lease.token());
				if(text.isEmpty()) { queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.failed("invalid_delivery_payload"));return true; }
				try { message=new TelegramTransport.Message(lease.chatId(),lease.threadId(),text.get(),lease.silent()); }
				catch(IllegalArgumentException invalid) { queue.finish(lease.id(),lease.token(),DeliveryQueue.Result.failed("invalid_delivery_payload"));return true; }
			}
			TelegramTransport.Outcome outcome;
			if(lease.commandReplyOutboxId()!=null && !queue.commandReplyReadyForSending(lease.id(),lease.token(),bot))return true;
			if(deletion!=null && !queue.panelDeleteReadyForSending(lease.id(),lease.token(),bot))return true;
			if(meetingMarkup && !queue.meetingReplyReadyForSending(lease.id(),lease.token(),bot))return true;
			try { outcome=deletion!=null?transport.delete(deletion):ack!=null?transport.acknowledge(ack):edit!=null?transport.edit(edit):transport.send(message); }
			catch(RuntimeException e) { outcome=TelegramTransport.Outcome.unknown("transport_exception_after_start"); }
			var result=DeliveryRetryPolicy.result(outcome,attempt);
			if("telegram_429".equals(result.code()))quota.block(bot,lease.chatId(),result.retryDelay());
			queue.finish(lease.id(),lease.token(),result);
		}finally { if(renewal!=null)renewal.cancel(false); }
		return true;
	}
	@Override public synchronized void stop() {
		if(!running.getAndSet(false))return;
		sender.shutdown();
		try { if(!sender.awaitTermination(8,TimeUnit.SECONDS))sender.shutdownNow(); }
		catch(InterruptedException e) { sender.shutdownNow();Thread.currentThread().interrupt(); }
		finally { heartbeats.shutdownNow(); }
		// Unfinished started work is left for unknown recovery, never released for automatic resend.
	}
	@Override public boolean isRunning() { return running.get(); }
	/** Local-process progress, not a delivery lease heartbeat or provider delivery confirmation. */
	public WorkerStatus workerStatus() {
		var c=cycle;var reference=c.completed()==null?lifecycleStartedAt:c.completed();
		Double age=reference==null?null:Duration.between(reference,clock.instant()).toMillis()/1000.0;
		String state=!running.get()?(busy.get()?"stopping":"stopped"):
				age!=null && age<0?"clock_uncertain":age!=null && age>30?"stalled":
				c.completed()==null?"starting":"error".equals(c.outcome())?"error":"healthy";
		return new WorkerStatus(state,busy.get(),c.started(),c.completed(),age,c.outcome(),c.failures());
	}
	private record Cycle(Instant started,Instant completed,String outcome,long failures) {}
	public record WorkerStatus(String state,boolean workInProgress,Instant lastCycleStartedAt,Instant lastCycleCompletedAt,Double lastProgressAgeSeconds,String lastOutcome,long consecutiveFailures) {}
	@Override public int getPhase() { return Integer.MAX_VALUE-100; }
}
