package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import tools.jackson.databind.ObjectMapper;

class DeliveryConfigurationTests {
	ApplicationContextRunner runner=new ApplicationContextRunner().withUserConfiguration(DeliveryConfiguration.class)
			.withBean(ru.itmomegabattle.megabot.telegram.TelegramReplyPlanner.class,()->mock(ru.itmomegabattle.megabot.telegram.TelegramReplyPlanner.class))
			.withBean(BirthdayReminderPlanner.class,()->mock(BirthdayReminderPlanner.class))
			.withBean(BroadcastExpiryPlanner.class,()->mock(BroadcastExpiryPlanner.class))
			.withBean(ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner.class,()->mock(ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner.class))
			.withBean(java.time.Clock.class,java.time.Clock::systemUTC)
			.withBean(ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner.class,()->mock(ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner.class))
			.withBean(ru.itmomegabattle.megabot.tasks.TaskManualPlanner.class,()->mock(ru.itmomegabattle.megabot.tasks.TaskManualPlanner.class))
			.withBean(ru.itmomegabattle.megabot.tasks.TaskReminderPlanner.class,()->mock(ru.itmomegabattle.megabot.tasks.TaskReminderPlanner.class))
			.withBean(DeliveryQueue.class,()->mock(DeliveryQueue.class)).withBean(DeliveryQuota.class,()->mock(DeliveryQuota.class))
			.withBean(ObjectMapper.class,ObjectMapper::new);
	@Test void noWorkerExistsUnlessExplicitlyEnabled() {
		runner.run(context->assertThat(context).doesNotHaveBean(BroadcastDispatcher.class));
		runner.withPropertyValues("megabot.integrations.telegram.mode=live","megabot.delivery.enabled=false")
				.run(context->assertThat(context).doesNotHaveBean(BroadcastDispatcher.class));
	}
	@Test void enabledFakeOrMissingCredentialsFailClosedWithoutNetwork() {
		runner.withPropertyValues("megabot.delivery.enabled=true","megabot.integrations.telegram.mode=fake")
				.run(context->assertThat(context.getStartupFailure()).hasRootCauseMessage("delivery_requires_explicit_live_mode"));
		runner.withPropertyValues("megabot.delivery.enabled=true","megabot.integrations.telegram.mode=live")
				.run(context->assertThat(context.getStartupFailure()).hasRootCauseMessage("invalid_telegram_credentials"));
	}
	@Test void liveTestWorkerCannotStartBeforeIsolationCheck() {
		runner.withInitializer(context->context.getEnvironment().setActiveProfiles("live-test"))
				.withPropertyValues("megabot.delivery.enabled=true","megabot.integrations.telegram.mode=live",
						"megabot.auth.telegram.bot-token="+LiveTestSafetyConfigurationTests.TOKEN)
				.run(context->assertThat(context.getStartupFailure()).hasRootCauseMessage("live_test_requires_isolated_database"));
	}
}
