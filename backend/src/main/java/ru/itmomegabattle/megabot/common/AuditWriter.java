package ru.itmomegabattle.megabot.common;

import java.util.Map;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import org.springframework.security.core.context.SecurityContextHolder;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@Component
public class AuditWriter {

	private final JdbcClient jdbc;
	private final ObjectMapper json;

	AuditWriter(JdbcClient jdbc, ObjectMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	public void write(String actorId, String entityType, String entityId, String action, Map<String, ?> changes) {
		jdbc.sql("""
				insert into audit_events(id, actor_id, entity_type, entity_id, action, changes)
				values (:id, :actorId, :entityType, :entityId, :action, cast(:changes as jsonb))
				""")
				.param("id", "audit_" + UUID.randomUUID())
				.param("actorId", actorId)
				.param("entityType", entityType)
				.param("entityId", entityId)
				.param("action", action)
				.param("changes", encode(changes))
				.update();
	}

	public void writeCurrent(String entityType, String entityId, String action, Map<String, ?> changes) {
		var authentication = SecurityContextHolder.getContext().getAuthentication();
		var actorId = authentication != null && authentication.getPrincipal() instanceof AuthenticatedUser actor
				? actor.id() : null;
		write(actorId, entityType, entityId, action, changes);
	}

	private String encode(Map<String, ?> changes) {
		try {
			return json.writeValueAsString(changes);
		} catch (JacksonException exception) {
			throw new IllegalStateException("Cannot serialize audit changes", exception);
		}
	}
}
