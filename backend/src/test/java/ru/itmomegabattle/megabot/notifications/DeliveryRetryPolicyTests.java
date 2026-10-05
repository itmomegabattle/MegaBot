package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class DeliveryRetryPolicyTests {
	@Test void backoffIsBoundedJitteredAndRespectsLongerRetryAfter() {
		long[] base={2,4,8,16,32,60,60,60};
		for(int n=1;n<=8;n++) {
			assertThat(DeliveryRetryPolicy.delay(n,null,0)).isEqualTo(Duration.ofSeconds(base[n-1]));
			assertThat(DeliveryRetryPolicy.delay(n,null,0.9)).isBetween(Duration.ofSeconds(base[n-1]),Duration.ofSeconds(base[n-1]+15));
		}
		assertThat(DeliveryRetryPolicy.delay(1,Duration.ofSeconds(90),0.5)).isEqualTo(Duration.ofSeconds(90));
	}
	@Test void unknownAndPermanentRefusalNeverBecomeAutomaticRetry() {
		assertThat(DeliveryRetryPolicy.result(TelegramTransport.Outcome.unknown("response_timeout"),1).status()).isEqualTo("unknown");
		assertThat(DeliveryRetryPolicy.result(TelegramTransport.Outcome.failed("telegram_403"),1).status()).isEqualTo("failed");
		assertThat(DeliveryRetryPolicy.result(TelegramTransport.Outcome.sent(10),1).messageId()).isEqualTo(10);
	}
}
