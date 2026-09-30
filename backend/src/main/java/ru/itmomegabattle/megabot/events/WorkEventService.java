package ru.itmomegabattle.megabot.events;

import java.time.Instant;
import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;

@Service
class WorkEventService {

	private final WorkEventRepository events;
	private final AuditWriter audit;

	WorkEventService(WorkEventRepository events, AuditWriter audit) {
		this.events = events;
		this.audit = audit;
	}

	@Transactional(readOnly = true)
	List<WorkEventController.EventView> list() {
		return events.findAllByOrderByStartsAtAscNameAsc().stream().map(WorkEventController.EventView::from).toList();
	}

	@Transactional
	WorkEventController.EventView create(WorkEventController.EventMutation request, AuthenticatedUser actor) {
		validateInterval(request.startsAt(), request.endsAt());
		var event = new WorkEventEntity(normalizeName(request.name()), normalizeDescription(request.description()),
				request.startsAt(), request.endsAt(), actor.id());
		var saved = events.saveAndFlush(event);
		audit.write(actor.id(), "work_event", saved.id(), "created", java.util.Map.of("name", saved.name()));
		return WorkEventController.EventView.from(saved);
	}

	@Transactional
	WorkEventController.EventView update(String id, WorkEventController.EventMutation request) {
		var event = require(id);
		checkVersion(event, request.expectedVersion());
		validateInterval(request.startsAt(), request.endsAt());
		event.update(normalizeName(request.name()), normalizeDescription(request.description()), request.startsAt(), request.endsAt());
		var saved = events.saveAndFlush(event);
		audit.writeCurrent("work_event", saved.id(), "updated", java.util.Map.of("version", saved.version()));
		return WorkEventController.EventView.from(saved);
	}

	@Transactional
	void archive(String id, long expectedVersion) {
		var event = require(id);
		checkVersion(event, expectedVersion);
		event.archive();
		events.saveAndFlush(event);
		audit.writeCurrent("work_event", event.id(), "archived", java.util.Map.of("version", event.version()));
	}

	static void validateInterval(Instant startsAt, Instant endsAt) {
		if (startsAt != null && endsAt != null && endsAt.isBefore(startsAt)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_event_interval", "Окончание события не может быть раньше начала");
		}
	}

	private String normalizeName(String name) {
		var normalized = name == null ? "" : name.strip().replaceAll("\\s+", " ");
		if (normalized.length() < 2 || normalized.length() > 120) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_event_name", "Название должно содержать 2–120 символов");
		}
		return normalized;
	}

	private String normalizeDescription(String description) {
		if (description == null || description.isBlank()) {
			return null;
		}
		var normalized = description.strip();
		if (normalized.length() > 4000) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_event_description", "Описание не должно превышать 4000 символов");
		}
		return normalized;
	}

	private WorkEventEntity require(String id) {
		return events.findById(id).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "event_not_found", "Событие не найдено"));
	}

	private void checkVersion(WorkEventEntity event, long expectedVersion) {
		if (event.version() != expectedVersion) {
			throw new ApiException(HttpStatus.CONFLICT, "stale_version", "Событие уже изменено. Обновите данные.");
		}
	}
}
