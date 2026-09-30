package ru.itmomegabattle.megabot.common;

import java.util.Arrays;
import java.util.Set;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration(proxyBeanMethods = false)
class IntegrationSafetyConfiguration {

	private static final Set<String> SAFE_PROFILES = Set.of("local", "test");

	@Bean
	IntegrationSafetyGuard integrationSafetyGuard(
			Environment environment,
			IntegrationModeProperties properties) {
		var activeProfiles = Set.copyOf(Arrays.asList(environment.getActiveProfiles()));
		if (activeProfiles.stream().anyMatch(SAFE_PROFILES::contains)) {
			requireFake("Telegram", properties.telegram());
			requireFake("Google", properties.google());
		}
		return new IntegrationSafetyGuard();
	}

	private static void requireFake(String integration, IntegrationModeProperties.Integration settings) {
		if (settings == null || !"fake".equals(settings.mode())) {
			throw new IllegalStateException(integration + " integration must use fake mode in local/test profiles");
		}
	}

	static final class IntegrationSafetyGuard {
	}
}
