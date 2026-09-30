package ru.itmomegabattle.megabot.common;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class IntegrationSafetyConfigurationTests {

	private final IntegrationSafetyConfiguration configuration = new IntegrationSafetyConfiguration();

	@Test
	void rejectsRealTelegramInLocalProfile() {
		var environment = new MockEnvironment().withProperty("spring.profiles.active", "local");
		environment.setActiveProfiles("local");
		var properties = new IntegrationModeProperties(
				new IntegrationModeProperties.Integration("real"),
				new IntegrationModeProperties.Integration("fake"));

		assertThatThrownBy(() -> configuration.integrationSafetyGuard(environment, properties))
				.isInstanceOf(IllegalStateException.class)
				.hasMessageContaining("Telegram");
	}
}
