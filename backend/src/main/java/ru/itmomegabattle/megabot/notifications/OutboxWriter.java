package ru.itmomegabattle.megabot.notifications;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Component
public class OutboxWriter {

	private final OutboxEventRepository repository;

	OutboxWriter(OutboxEventRepository repository) {
		this.repository = repository;
	}

	@Transactional(propagation = Propagation.MANDATORY)
	public String write(
			String aggregateType,
			String aggregateId,
			String eventType,
			String dedupeKey,
			String jsonPayload,
			Instant availableAt) {
		var id = "outbox_" + UUID.randomUUID();
		repository.save(new OutboxEventEntity(
				id,
				aggregateType,
				aggregateId,
				eventType,
				dedupeKey,
				jsonPayload,
				availableAt));
		return id;
	}
}
