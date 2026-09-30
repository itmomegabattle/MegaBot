package ru.itmomegabattle.megabot.common;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
class ApiExceptionHandler {

	private final Clock clock;

	ApiExceptionHandler(Clock clock) {
		this.clock = clock;
	}

	@ExceptionHandler(ApiException.class)
	ResponseEntity<ApiError> api(ApiException exception) {
		return ResponseEntity.status(exception.status())
				.body(new ApiError(exception.code(), exception.getMessage(), exception.fieldErrors(), clock.instant()));
	}

	@ExceptionHandler(MethodArgumentNotValidException.class)
	ResponseEntity<ApiError> validation(MethodArgumentNotValidException exception) {
		var errors = new LinkedHashMap<String, String>();
		exception.getBindingResult().getFieldErrors().forEach(error -> errors.putIfAbsent(
				error.getField(), error.getDefaultMessage()));
		return ResponseEntity.badRequest()
				.body(new ApiError("validation_failed", "Проверьте заполненные поля", errors, clock.instant()));
	}

	@ExceptionHandler(ObjectOptimisticLockingFailureException.class)
	ResponseEntity<ApiError> stale(ObjectOptimisticLockingFailureException exception) {
		return ResponseEntity.status(HttpStatus.CONFLICT)
				.body(new ApiError("stale_version", "Данные уже изменились. Обновите страницу.", Map.of(), clock.instant()));
	}

	@ExceptionHandler(DataIntegrityViolationException.class)
	ResponseEntity<ApiError> conflict(DataIntegrityViolationException exception) {
		return ResponseEntity.status(HttpStatus.CONFLICT)
				.body(new ApiError("constraint_violation", "Изменение конфликтует с существующими данными", Map.of(), clock.instant()));
	}

	record ApiError(String code, String message, Map<String, String> fieldErrors, Instant serverNow) {
	}
}
