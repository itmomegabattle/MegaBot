package ru.itmomegabattle.megabot.notifications;

import java.time.Duration;
import java.time.Clock;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.core.env.Environment;
import tools.jackson.databind.ObjectMapper;

@Configuration(proxyBeanMethods=false)
@EnableScheduling
@ConditionalOnProperty(prefix="megabot.delivery",name="enabled",havingValue="true")
class DeliveryConfiguration {
	@Bean BroadcastDispatcher broadcastDispatcher(DeliveryQueue queue,DeliveryQuota quota,ObjectMapper json,ru.itmomegabattle.megabot.tasks.TaskReminderPlanner reminders,ru.itmomegabattle.megabot.tasks.TaskManualPlanner manual,Clock clock,ru.itmomegabattle.megabot.meetings.MeetingNotificationPlanner meetings,ru.itmomegabattle.megabot.availability.AvailabilityReminderPlanner availability,BirthdayReminderPlanner birthdays,BroadcastExpiryPlanner expirations,ru.itmomegabattle.megabot.telegram.TelegramReplyPlanner replies,
			@Value("${megabot.integrations.telegram.mode:disabled}") String mode,@Value("${megabot.auth.telegram.bot-token:}") String token,
			@Value("${megabot.delivery.bot-per-second:20}") int botRate,@Value("${megabot.delivery.private-per-second:1}") int privateRate,
			@Value("${megabot.delivery.group-per-minute:20}") int groupRate,Environment environment) {
		if(!"live".equals(mode))throw new IllegalStateException("delivery_requires_explicit_live_mode");
		if(environment.matchesProfiles("live-test"))LiveTestSafetyConfiguration.validate(environment);
		var transport=environment.matchesProfiles("live-test")
				?new TelegramHttpTransport(json,token,Duration.ofSeconds(8),LiveTestSafetyConfiguration.BOT_ID,LiveTestSafetyConfiguration.RECIPIENTS)
				:new TelegramHttpTransport(json,token,Duration.ofSeconds(8));
		return new BroadcastDispatcher(queue,quota,transport,json,token.substring(0,token.indexOf(':')),new DeliveryQuota.Limits(botRate,privateRate,groupRate),reminders,manual,clock,meetings,availability,birthdays,expirations,replies);
	}
}
