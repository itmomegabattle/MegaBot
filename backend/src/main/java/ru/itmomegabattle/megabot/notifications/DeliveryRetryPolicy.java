package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

public final class DeliveryRetryPolicy {
	private DeliveryRetryPolicy() {}
	public static DeliveryQueue.Result result(TelegramTransport.Outcome outcome,int attempt) {
		return switch(outcome.kind()) {
			case SENT -> new DeliveryQueue.Result("sent",null,outcome.messageId(),null);
			case FAILED -> DeliveryQueue.Result.failed(outcome.code());
			case UNKNOWN -> DeliveryQueue.Result.unknown(outcome.code());
			case RETRY -> DeliveryQueue.Result.retry(outcome.code(),delay(attempt,outcome.retryAfter(),ThreadLocalRandom.current().nextDouble()));
		};
	}
	static Duration delay(int attempt,Duration retryAfter,double jitter) {
		if(attempt<1 || attempt>8 || jitter<0 || jitter>=1)throw new IllegalArgumentException("invalid_retry_input");
		var base=Math.min(60,2L<<Math.min(5,attempt-1));
		var delay=Duration.ofMillis(base*1000+(long)(base*250*jitter));
		return retryAfter!=null && retryAfter.compareTo(delay)>0?retryAfter:delay;
	}
}
