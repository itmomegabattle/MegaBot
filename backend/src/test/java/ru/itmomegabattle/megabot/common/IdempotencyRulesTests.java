package ru.itmomegabattle.megabot.common;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class IdempotencyRulesTests {

	@Test
	void acceptsUuidLikeKeysAndRejectsUnsafeOrShortValues() {
		assertThatCode(() -> IdempotencyService.validateKey("550e8400-e29b-41d4-a716-446655440000"))
				.doesNotThrowAnyException();
		assertThatThrownBy(() -> IdempotencyService.validateKey("short")).isInstanceOf(ApiException.class);
		assertThatThrownBy(() -> IdempotencyService.validateKey("unsafe key!")).isInstanceOf(ApiException.class);
	}
}
