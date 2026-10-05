package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.time.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.*;
import tools.jackson.databind.ObjectMapper;

class WorkerProgressTests {
	DeliveryQueue queue;BroadcastDispatcher worker;AtomicReference<Instant> now;
	@BeforeEach void prepare() {
		queue=mock(DeliveryQueue.class);now=new AtomicReference<>(Instant.parse("2026-10-04T12:00:00Z"));
		var clock=mock(Clock.class);when(clock.instant()).thenAnswer(i->now.get());
		worker=new BroadcastDispatcher(queue,mock(DeliveryQuota.class),m->{throw new AssertionError("no network expected");},new ObjectMapper(),"123",DeliveryQuota.Limits.defaults(),null,null,clock);
	}
	@AfterEach void close() { worker.stop(); }
	@Test void emptyQueueIsHealthyAndThirtySecondSilenceIsStalledNotDisabled() {
		worker.start();assertThat(worker.workerStatus().state()).isEqualTo("starting");
		assertThat(worker.dispatchOne()).isFalse();var heartbeat=worker.workerStatus().lastCycleCompletedAt();
		assertThat(worker.workerStatus().state()).isEqualTo("healthy");assertThat(worker.workerStatus().lastOutcome()).isEqualTo("idle");
		now.set(now.get().plusSeconds(30));assertThat(worker.workerStatus().state()).isEqualTo("healthy");
		now.set(now.get().plusSeconds(1));assertThat(worker.workerStatus().state()).isEqualTo("stalled");
		assertThat(worker.workerStatus().lastProgressAgeSeconds()).isEqualTo(31);
		assertThat(worker.workerStatus().lastCycleCompletedAt()).isEqualTo(heartbeat); // Reading diagnostics does not revive the worker.
	}
	@Test void consecutiveFailuresAreSafeAndSuccessfulCycleResetsThem() {
		worker.start();when(queue.recoverExpiredLeases()).thenThrow(new IllegalStateException("SECRET_DATABASE_URI"));
		assertThatThrownBy(worker::dispatchOne).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(worker::dispatchOne).isInstanceOf(IllegalStateException.class);
		assertThat(worker.workerStatus().state()).isEqualTo("error");assertThat(worker.workerStatus().consecutiveFailures()).isEqualTo(2);
		assertThat(new ObjectMapper().writeValueAsString(worker.workerStatus())).doesNotContain("SECRET_","exception","token");
		doReturn(0).when(queue).recoverExpiredLeases();now.set(now.get().plusSeconds(2));assertThat(worker.dispatchOne()).isFalse();
		assertThat(worker.workerStatus().state()).isEqualTo("healthy");assertThat(worker.workerStatus().consecutiveFailures()).isZero();
	}
	@Test void blockedCycleDoesNotFakeCompletionOrCreateUnboundedWakeups() throws Exception {
		var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
		when(queue.recoverExpiredLeases()).thenAnswer(i->{entered.countDown();assertThat(release.await(5,TimeUnit.SECONDS)).isTrue();return 0;});
		worker.start();worker.wakeup();assertThat(entered.await(2,TimeUnit.SECONDS)).isTrue();
		try {
			assertThat(worker.workerStatus().workInProgress()).isTrue();assertThat(worker.workerStatus().lastCycleCompletedAt()).isNull();
			now.set(now.get().plusSeconds(31));assertThat(worker.workerStatus().state()).isEqualTo("stalled");
			for(int n=0;n<50;n++)worker.wakeup();verify(queue,times(1)).recoverExpiredLeases();
		}finally { release.countDown(); }
		await(()->!worker.workerStatus().workInProgress());
		assertThat(worker.workerStatus().state()).isEqualTo("healthy");assertThat(worker.workerStatus().lastOutcome()).isEqualTo("idle");
	}
	@Test void schedulerContainsFailureAndContinuesWithNextCycle() {
		when(queue.recoverExpiredLeases()).thenThrow(new IllegalStateException("SECRET_SCHEDULER_ERROR")).thenReturn(0);
		worker.start();worker.wakeup();await(()->!worker.workerStatus().workInProgress());
		assertThat(worker.workerStatus().state()).isEqualTo("error");assertThat(worker.isRunning()).isTrue();
		worker.wakeup();await(()->!worker.workerStatus().workInProgress());
		assertThat(worker.workerStatus().state()).isEqualTo("healthy");verify(queue,times(2)).recoverExpiredLeases();
	}
	@Test void stoppedAndBackwardClockAreExplicitNotInventedHealthyProgress() {
		assertThat(worker.workerStatus().state()).isEqualTo("stopped");worker.start();worker.dispatchOne();
		now.set(now.get().minusSeconds(1));assertThat(worker.workerStatus().state()).isEqualTo("clock_uncertain");
		worker.stop();assertThat(worker.workerStatus().state()).isEqualTo("stopped");assertThat(worker.isRunning()).isFalse();
	}
	@Test void oneWakeupDrainsReadyWorkAndStopsAtEmptyQueue() {
		var lease=new DeliveryQueue.Lease("id","token",1L,null,null,"{}",true,now.get(),now.get().plusSeconds(30));
		when(queue.claimBroadcasts(1,Duration.ofSeconds(30),"123")).thenReturn(java.util.List.of(lease),java.util.List.of(lease),java.util.List.of());
		worker.start();worker.wakeup();await(()->!worker.workerStatus().workInProgress());
		verify(queue,times(3)).claimBroadcasts(1,Duration.ofSeconds(30),"123");
		assertThat(worker.workerStatus().lastOutcome()).isEqualTo("idle");
	}
	@Test void continuouslyReadyQueueCannotCreateUnboundedDrain() {
		var lease=new DeliveryQueue.Lease("id","token",1L,null,null,"{}",true,now.get(),now.get().plusSeconds(30));
		when(queue.claimBroadcasts(1,Duration.ofSeconds(30),"123")).thenReturn(java.util.List.of(lease));
		worker.start();worker.wakeup();await(()->!worker.workerStatus().workInProgress());
		int claims=(int)mockingDetails(queue).getInvocations().stream().filter(i->i.getMethod().getName().equals("claimBroadcasts")).count();
		assertThat(claims).isBetween(2,100);
	}
	private void await(BooleanSupplier done) {
		long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
		while(!done.getAsBoolean() && System.nanoTime()<deadline)LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(5));
		assertThat(done.getAsBoolean()).isTrue();
	}
}
