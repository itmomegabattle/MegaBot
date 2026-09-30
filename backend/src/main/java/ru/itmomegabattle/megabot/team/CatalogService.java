package ru.itmomegabattle.megabot.team;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;

@Service
class CatalogService {

	private final JdbcClient jdbc;
	private final AuditWriter audit;

	CatalogService(JdbcClient jdbc, AuditWriter audit) {
		this.jdbc = jdbc;
		this.audit = audit;
	}

	@Transactional(readOnly = true)
	CatalogController.CatalogView get() {
		var competencies = jdbc.sql("select id, name, scope, active, version from competencies where active order by scope, name")
				.query((row, index) -> new CatalogController.CompetencyView(row.getString("id"), row.getString("name"),
						row.getString("scope"), row.getBoolean("active"), row.getLong("version"))).list();
		var faculties = jdbc.sql("select id, name, active, version from faculties where active order by name")
				.query((row, index) -> new CatalogController.FacultyView(row.getString("id"), row.getString("name"),
						row.getBoolean("active"), row.getLong("version"))).list();
		return new CatalogController.CatalogView(competencies, faculties);
	}

	@Transactional
	CatalogController.CompetencyView createCompetency(CatalogController.CreateCompetency request, AuthenticatedUser actor) {
		var scope = normalizeScope(request.scope());
		var id = "cmp_" + UUID.randomUUID();
		var name = normalizeName(request.name(), "Название компетенции");
		jdbc.sql("insert into competencies(id, name, scope) values (:id, :name, :scope)")
				.param("id", id).param("name", name).param("scope", scope).update();
		audit.write(actor.id(), "competency", id, "created", java.util.Map.of("name", name, "scope", scope));
		return new CatalogController.CompetencyView(id, name, scope, true, 0);
	}

	@Transactional
	CatalogController.CompetencyView updateCompetency(String id, CatalogController.UpdateName request) {
		var changed = jdbc.sql("update competencies set name = :name, version = version + 1 where id = :id and version = :version and active")
				.param("name", normalizeName(request.name(), "Название компетенции"))
				.param("id", id).param("version", request.expectedVersion()).update();
		if (changed == 0) throw staleOrMissing("competencies", id, "Компетенция");
		audit.writeCurrent("competency", id, "updated", java.util.Map.of("name", request.name()));
		return competency(id);
	}

	@Transactional
	void retireCompetency(String id, long expectedVersion) {
		var changed = jdbc.sql("update competencies set active = false, version = version + 1 where id = :id and version = :version and active")
				.param("id", id).param("version", expectedVersion).update();
		if (changed == 0) throw staleOrMissing("competencies", id, "Компетенция");
		audit.writeCurrent("competency", id, "retired", java.util.Map.of("version", expectedVersion + 1));
	}

	@Transactional
	CatalogController.FacultyView createFaculty(CatalogController.CreateFaculty request, AuthenticatedUser actor) {
		var id = "fac_" + UUID.randomUUID();
		var name = normalizeName(request.name(), "Название факультета");
		jdbc.sql("insert into faculties(id, name) values (:id, :name)").param("id", id).param("name", name).update();
		audit.write(actor.id(), "faculty", id, "created", java.util.Map.of("name", name));
		return new CatalogController.FacultyView(id, name, true, 0);
	}

	@Transactional
	CatalogController.FacultyView updateFaculty(String id, CatalogController.UpdateName request) {
		var changed = jdbc.sql("update faculties set name = :name, version = version + 1 where id = :id and version = :version and active")
				.param("name", normalizeName(request.name(), "Название факультета"))
				.param("id", id).param("version", request.expectedVersion()).update();
		if (changed == 0) throw staleOrMissing("faculties", id, "Факультет");
		audit.writeCurrent("faculty", id, "updated", java.util.Map.of("name", request.name()));
		return faculty(id);
	}

	@Transactional
	void retireFaculty(String id, long expectedVersion) {
		var activeMembers = jdbc.sql("select count(*) from faculty_memberships where faculty_id = :id")
				.param("id", id).query(Long.class).single();
		if (activeMembers > 0) {
			throw new ApiException(HttpStatus.CONFLICT, "faculty_has_members", "Сначала переназначьте участников факультета");
		}
		var changed = jdbc.sql("update faculties set active = false, version = version + 1 where id = :id and version = :version and active")
				.param("id", id).param("version", expectedVersion).update();
		if (changed == 0) throw staleOrMissing("faculties", id, "Факультет");
		audit.writeCurrent("faculty", id, "retired", java.util.Map.of("version", expectedVersion + 1));
	}

	@Transactional
	void setMembership(String facultyId, String userId, CatalogController.MembershipMutation request) {
		var facultyExists = jdbc.sql("select count(*) from faculties where id = :id and active")
				.param("id", facultyId).query(Long.class).single();
		if (facultyExists == 0) throw new ApiException(HttpStatus.NOT_FOUND, "faculty_not_found", "Факультет не найден");
		var userRole = jdbc.sql("select role from users where id = :id and active").param("id", userId)
				.query(String.class).optional()
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "Участник не найден"));
		if (!userRole.startsWith("faculty_")) {
			throw new ApiException(HttpStatus.CONFLICT, "not_faculty_user", "Основную команду нельзя включить в факультетский контур");
		}
		var role = normalizeFacultyRole(request.facultyRole());
		jdbc.sql("""
				insert into faculty_memberships(user_id, faculty_id, faculty_role) values (:userId, :facultyId, :role)
				on conflict (user_id) do update set faculty_id = excluded.faculty_id, faculty_role = excluded.faculty_role
				""").param("userId", userId).param("facultyId", facultyId).param("role", role).update();
		audit.writeCurrent("faculty_membership", userId, "assigned", java.util.Map.of("facultyId", facultyId, "role", role));
	}

	@Transactional
	void removeMembership(String facultyId, String userId) {
		jdbc.sql("delete from faculty_memberships where user_id = :userId and faculty_id = :facultyId")
				.param("userId", userId).param("facultyId", facultyId).update();
		audit.writeCurrent("faculty_membership", userId, "removed", java.util.Map.of("facultyId", facultyId));
	}

	@Transactional
	void setUserCompetencies(String userId, CatalogController.UserCompetenciesMutation request) {
		var userRole = jdbc.sql("select role from users where id = :id and active").param("id", userId)
				.query(String.class).optional()
				.orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "Участник не найден"));
		var ids = request.competencyIds().stream().distinct().toList();
		if (request.primaryCompetencyId() != null && !ids.contains(request.primaryCompetencyId())) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "primary_not_selected", "Основная компетенция должна входить в выбранные");
		}
		if (!ids.isEmpty()) {
			var requiredScope = userRole.startsWith("faculty_") ? "faculty" : "core";
			var found = jdbc.sql("select count(*) from competencies where id in (:ids) and active and scope = :scope")
					.param("ids", ids).param("scope", requiredScope).query(Long.class).single();
			if (found != ids.size()) {
				throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_competency_scope", "Компетенции не существуют или относятся к другому контуру");
			}
		}
		jdbc.sql("delete from user_competencies where user_id = :userId").param("userId", userId).update();
		for (var id : ids) {
			jdbc.sql("insert into user_competencies(user_id, competency_id, is_primary) values (:userId, :id, :primary)")
					.param("userId", userId).param("id", id).param("primary", id.equals(request.primaryCompetencyId())).update();
		}
		audit.writeCurrent("user_competencies", userId, "replaced", java.util.Map.of("competencyIds", ids,
				"primaryCompetencyId", request.primaryCompetencyId() == null ? "" : request.primaryCompetencyId()));
	}

	private CatalogController.CompetencyView competency(String id) {
		return jdbc.sql("select id, name, scope, active, version from competencies where id = :id").param("id", id)
				.query((row, index) -> new CatalogController.CompetencyView(row.getString("id"), row.getString("name"),
						row.getString("scope"), row.getBoolean("active"), row.getLong("version"))).single();
	}

	private CatalogController.FacultyView faculty(String id) {
		return jdbc.sql("select id, name, active, version from faculties where id = :id").param("id", id)
				.query((row, index) -> new CatalogController.FacultyView(row.getString("id"), row.getString("name"),
						row.getBoolean("active"), row.getLong("version"))).single();
	}

	private ApiException staleOrMissing(String table, String id, String label) {
		var exists = jdbc.sql("select count(*) from " + table + " where id = :id").param("id", id).query(Long.class).single();
		return exists == 0
				? new ApiException(HttpStatus.NOT_FOUND, "catalog_item_not_found", label + " не найден")
				: new ApiException(HttpStatus.CONFLICT, "stale_version", label + " уже изменён");
	}

	static String normalizeScope(String raw) {
		var value = raw == null ? "" : raw.toLowerCase(Locale.ROOT);
		if (!List.of("core", "faculty").contains(value)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_competency_scope", "Scope должен быть core или faculty");
		}
		return value;
	}

	static String normalizeFacultyRole(String raw) {
		var value = raw == null ? "" : raw.toLowerCase(Locale.ROOT);
		if (!List.of("responsible", "helper", "member").contains(value)) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_faculty_role", "Неизвестная роль в факультете");
		}
		return value;
	}

	static String normalizeName(String raw, String label) {
		var value = raw == null ? "" : raw.strip().replaceAll("\\s+", " ");
		if (value.length() < 2 || value.length() > 120) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_catalog_name", label + " должно содержать 2–120 символов");
		}
		return value;
	}
}
