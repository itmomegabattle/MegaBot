package ru.itmomegabattle.megabot.auth;

class AuthenticationRejectedException extends RuntimeException {

	AuthenticationRejectedException(String message) {
		super(message);
	}
}
