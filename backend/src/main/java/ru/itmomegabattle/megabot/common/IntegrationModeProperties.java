package ru.itmomegabattle.megabot.common;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "megabot.integrations")
public record IntegrationModeProperties(Integration telegram, Integration google) {

	public record Integration(String mode) {
	}
}
