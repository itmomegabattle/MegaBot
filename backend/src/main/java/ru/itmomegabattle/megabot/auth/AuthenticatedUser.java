package ru.itmomegabattle.megabot.auth;

public record AuthenticatedUser(String id, String username, String realName, String role) {
}
