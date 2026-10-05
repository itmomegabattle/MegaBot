package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import ru.itmomegabattle.megabot.notifications.DeliveryDiagnosticsController.*;

class DeliveryDiagnosticSignalsTests {
	Snapshot snapshot(String state,long due,Double age,long stale,long unknown,long early,int awaiting) {
		return new Snapshot(Instant.EPOCH,24,
				new Queue(0,0,0,0,0,0,0,unknown,0,0,due,age,stale),
				new Timings(0,0,early,null,null,null,null,0,null),new Pool(1,0,1,awaiting,5),
				new BroadcastDispatcher.WorkerStatus(state,false,null,null,null,null,0),List.of("ntpClockOffset","devicePushLatency"));
	}
	@Test void idleDisabledStartingAndShutdownDoNotFabricateFailure() {
		for(var state:List.of("healthy","disabled","starting","stopping","stopped"))
			assertThat(snapshot(state,0,null,0,0,0,0).signals()).isEmpty();
	}
	@Test void backlogThresholdIsStrictAndDoesNotClaimQuotaOrWorkerFailure() {
		assertThat(snapshot("healthy",1,10.0,0,0,0,0).signals()).isEmpty();
		assertThat(snapshot("healthy",0,11.0,0,0,0,0).signals()).isEmpty();
		assertThat(snapshot("healthy",1,null,0,0,0,0).signals()).isEmpty();
		for(var state:List.of("healthy","disabled"))
			assertThat(snapshot(state,1,10.001,0,0,0,0).signals())
					.containsExactly(new Signal("due_backlog_quota_unverified","warning"));
	}
	@Test void workerStatesRemainDistinctAndRecoveryClearsTheirSignals() {
		assertThat(snapshot("stalled",0,null,0,0,0,0).signals()).containsExactly(new Signal("worker_stalled","critical"));
		assertThat(snapshot("error",0,null,0,0,0,0).signals()).containsExactly(new Signal("worker_error","warning"));
		assertThat(snapshot("clock_uncertain",0,null,0,0,0,0).signals()).containsExactly(new Signal("worker_clock_uncertain","warning"));
		assertThat(snapshot("healthy",0,null,0,0,0,0).signals()).isEmpty();
	}
	@Test void independentSignalsCoexistAndDoNotMutateQueueOrRetryUnknown() {
		var s=snapshot("stalled",1,11.0,2,3,4,1);
		assertThat(s.signals()).containsExactly(new Signal("worker_stalled","critical"),
				new Signal("due_backlog_quota_unverified","warning"),new Signal("stale_leases","warning"),
				new Signal("unknown_outcomes","warning"),new Signal("early_attempts","critical"),new Signal("database_pool_waiters","warning"));
		assertThatThrownBy(()->s.signals().clear()).isInstanceOf(UnsupportedOperationException.class);
		assertThat(s.queue().unknown()).isEqualTo(3);
		assertThat(s.signals()).hasSize(6);
		var absentPool=new Snapshot(s.databaseNow(),24,s.queue(),s.timings(),null,s.worker(),s.notMeasured());
		assertThat(absentPool.signals()).doesNotContain(new Signal("database_pool_waiters","warning"));
	}
}
