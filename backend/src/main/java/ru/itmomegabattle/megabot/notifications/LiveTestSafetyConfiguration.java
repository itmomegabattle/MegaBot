package ru.itmomegabattle.megabot.notifications;

import java.util.Arrays;
import java.util.Set;
import org.springframework.context.ApplicationContextInitializer;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;

/** Owner-approved test boundary; widening it requires a reviewed code change, not an env override. */
public final class LiveTestSafetyConfiguration implements ApplicationContextInitializer<ConfigurableApplicationContext> {
	static final long BOT_ID=8832831571L;
	static final Set<Long> RECIPIENTS=Set.of(658274366L,703359098L);
	static final String DB_URL="jdbc:postgresql://127.0.0.1:55432/megabot_live_test";

	@Override public void initialize(ConfigurableApplicationContext context) {
		// Runs before bean creation: even Flyway/Hikari must not touch an overridden database.
		if(context.getEnvironment().matchesProfiles("live-test"))validate(context.getEnvironment());
	}
	static void validate(Environment environment) {
		if(!Arrays.equals(environment.getActiveProfiles(),new String[]{"live-test"}))
			throw new IllegalStateException("live_test_requires_exclusive_profile");
		if(!DB_URL.equals(environment.getProperty("spring.datasource.url"))
				|| !"megabot_live_test_app".equals(environment.getProperty("spring.datasource.username")))
			throw new IllegalStateException("live_test_requires_isolated_database");
		if(!"127.0.0.1".equals(environment.getProperty("server.address"))
				|| !"18081".equals(environment.getProperty("server.port")))
			throw new IllegalStateException("live_test_requires_loopback_server");
		if(!"disabled".equals(environment.getProperty("megabot.integrations.google.mode")))
			throw new IllegalStateException("live_test_requires_disabled_google");
		var token=environment.getProperty("megabot.auth.telegram.bot-token","");
		if(!token.matches(BOT_ID+":"+"[A-Za-z0-9_-]{20,}"))
			throw new IllegalStateException("live_test_requires_agreed_bot");
	}
}
