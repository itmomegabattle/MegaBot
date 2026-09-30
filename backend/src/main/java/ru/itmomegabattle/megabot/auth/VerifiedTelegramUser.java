package ru.itmomegabattle.megabot.auth;

public record VerifiedTelegramUser(long id, String username, String firstName, String lastName) {

	public String displayName() {
		var result = String.join(" ", firstName == null ? "" : firstName, lastName == null ? "" : lastName).trim();
		return result.isEmpty() ? (username == null ? "Telegram user" : username) : result;
	}
}
