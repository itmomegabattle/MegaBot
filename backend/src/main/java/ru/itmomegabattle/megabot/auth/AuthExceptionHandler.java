package ru.itmomegabattle.megabot.auth;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
class AuthExceptionHandler {

	@ExceptionHandler(AuthenticationRejectedException.class)
	ResponseEntity<AuthController.ApiError> authenticationRejected(AuthenticationRejectedException exception) {
		return ResponseEntity.status(HttpStatus.FORBIDDEN)
				.body(new AuthController.ApiError("authentication_rejected", exception.getMessage()));
	}
}
