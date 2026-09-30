package ru.itmomegabattle.megabot.common;

import java.time.Clock;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class ClockConfiguration {

	@Bean
	Clock applicationClock() {
		return Clock.systemUTC();
	}
}
