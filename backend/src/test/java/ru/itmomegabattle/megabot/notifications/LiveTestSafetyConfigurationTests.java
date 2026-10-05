package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

class LiveTestSafetyConfigurationTests {
	static final String TOKEN="8832831571:"+"x".repeat(25);
	ApplicationContextRunner runner=new ApplicationContextRunner()
			.withInitializer(context->{
				if(context.getEnvironment().getActiveProfiles().length==0)context.getEnvironment().setActiveProfiles("live-test");
				new LiveTestSafetyConfiguration().initialize(context);
			})
			.withPropertyValues("spring.datasource.url="+LiveTestSafetyConfiguration.DB_URL,
					"spring.datasource.username=megabot_live_test_app","server.address=127.0.0.1","server.port=18081",
					"megabot.integrations.google.mode=disabled","megabot.auth.telegram.bot-token="+TOKEN);

	@Test void isolatedConfigurationIsAcceptedEvenWithSenderOff() {
		runner.withPropertyValues("megabot.delivery.enabled=false").run(context->assertThat(context).hasNotFailed());
	}
	@Test void wrongOrMissingTokenIsRejectedWithoutExposingCredentials() {
		for(var token:new String[]{"","111:"+"secret".repeat(5),"8832831571:bad/path"})
			runner.withPropertyValues("megabot.auth.telegram.bot-token="+token)
					.run(context->assertThat(context.getStartupFailure()).hasMessage("live_test_requires_agreed_bot"));
	}
	@Test void databaseExternalBindingAndGoogleOverridesFailClosed() {
		for(var property:new String[]{"spring.datasource.url=jdbc:postgresql://prod:5432/megabot","spring.datasource.username=megabot_app",
				"server.address=0.0.0.0","server.port=8080","megabot.integrations.google.mode=live"})
			runner.withPropertyValues(property).run(context->assertThat(context).hasFailed());
	}
	@Test void mixedProfilesAreRejected() {
		for(var profile:new String[]{"prod","local","test"})runner
				.withPropertyValues("spring.profiles.active=live-test,"+profile)
				.withInitializer(context->context.getEnvironment().setActiveProfiles("live-test",profile))
				.run(context->assertThat(context.getStartupFailure()).hasMessage("live_test_requires_exclusive_profile"));
	}
	@Test void springBootRegistersGuardBeforeAnyDatabaseConnectionOrMigration() {
		var app=new org.springframework.boot.SpringApplication(ru.itmomegabattle.megabot.MegaBotApplication.class);
		app.setLogStartupInfo(false);
		assertThatThrownBy(()->app.run("--spring.profiles.active=live-test",
				"--spring.datasource.url=jdbc:postgresql://127.0.0.1:1/do_not_connect",
				"--megabot.delivery.enabled=false","--megabot.auth.telegram.bot-token="+TOKEN))
				.hasMessage("live_test_requires_isolated_database");
	}
}
