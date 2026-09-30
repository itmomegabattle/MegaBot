package ru.itmomegabattle.megabot.team;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.MonthDay;
import java.util.List;
import java.util.Locale;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.auth.SessionService;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.common.AuditWriter;

@Service
class TeamService {

	private final UserRepository users;
	private final SessionService sessions;
	private final JdbcClient jdbc;
	private final Clock clock;
	private final AuditWriter audit;

	TeamService(UserRepository users, SessionService sessions, JdbcClient jdbc, Clock clock, AuditWriter audit) {
		this.users = users;
		this.sessions = sessions;
		this.jdbc = jdbc;
		this.clock = clock;
		this.audit = audit;
	}

	@Transactional(readOnly = true)
	List<TeamController.UserView> listActive() {
		return users.findByActiveTrue(org.springframework.data.domain.Pageable.unpaged()).stream()
				.filter(user -> TeamRole.parse(user.getRole()).isCore())
				.map(user -> view(user, false))
				.toList();
	}

	@Transactional(readOnly = true)
	TeamController.UserView profile(AuthenticatedUser actor) {
		return view(requireUser(actor.id()), true);
	}

	@Transactional
	TeamController.UserView create(TeamController.CreateUserRequest request, AuthenticatedUser actor) {
		var role = TeamRole.parse(request.role());
		var username = normalizeUsername(request.username());
		if (request.telegramId() != null && users.existsByTelegramId(request.telegramId())) {
			throw new ApiException(HttpStatus.CONFLICT, "telegram_id_taken", "Этот Telegram ID уже привязан");
		}
		var user = new UserEntity(request.telegramId(), username, normalizeName(request.realName()), role.value());
		applyBirthday(user, request.birthdayDay(), request.birthdayMonth(), request.birthdayYear());
		var saved = users.saveAndFlush(user);
		audit.write(actor.id(), "user", saved.getId(), "created", java.util.Map.of("role", saved.getRole(), "username", saved.getUsername()));
		return view(saved, true);
	}

	@Transactional
	TeamController.UserView updateOwn(AuthenticatedUser actor, TeamController.UpdateProfileRequest request) {
		var user = requireUser(actor.id());
		checkVersion(user, request.expectedVersion());
		var date = birthday(request.birthdayDay(), request.birthdayMonth(), request.birthdayYear());
		user.updateProfile(normalizeName(request.realName()), normalizeUsername(request.username()),
				date.day, date.month, date.year);
		var saved = users.saveAndFlush(user);
		audit.write(actor.id(), "user", saved.getId(), "profile_updated", java.util.Map.of("version", saved.getVersion()));
		return view(saved, true);
	}

	@Transactional
	TeamController.UserView updateByAdmin(String id, TeamController.AdminUpdateUserRequest request) {
		var user = requireUser(id);
		checkVersion(user, request.expectedVersion());
		var nextRole = TeamRole.parse(request.role());
		if ("admin".equals(user.getRole()) && nextRole != TeamRole.ADMIN) {
			lockAndRequireAnotherAdmin(user.getId());
		}
		var date = birthday(request.birthdayDay(), request.birthdayMonth(), request.birthdayYear());
		user.updateProfile(normalizeName(request.realName()), normalizeUsername(request.username()), date.day, date.month, date.year);
		user.changeRole(nextRole.value());
		if (Boolean.TRUE.equals(request.active()) && !user.isActive()) {
			user.reactivate();
		}
		var saved = users.saveAndFlush(user);
		audit.writeCurrent("user", saved.getId(), "admin_updated", java.util.Map.of("role", saved.getRole(), "version", saved.getVersion()));
		return view(saved, true);
	}

	@Transactional
	void deactivate(String id, long expectedVersion, AuthenticatedUser actor) {
		var user = requireUser(id);
		checkVersion(user, expectedVersion);
		if (!user.isActive()) {
			return;
		}
		if ("admin".equals(user.getRole())) {
			lockAndRequireAnotherAdmin(user.getId());
		}
		var futureMeetings = jdbc.sql("select count(*) from meetings where host_id = :id and status = 'scheduled' and starts_at > now()")
				.param("id", id).query(Long.class).single();
		var unfinishedTasks = jdbc.sql("select count(*) from task_assignees a join tasks t on t.id = a.task_id where a.user_id = :id and t.status not in ('completed', 'cancelled')")
				.param("id", id).query(Long.class).single();
		if (futureMeetings > 0 || unfinishedTasks > 0) {
			throw new ApiException(HttpStatus.CONFLICT, "deactivation_requires_reassignment",
					"Сначала переназначьте будущие встречи и подтвердите возврат незавершённых задач");
		}
		user.deactivate(actor.id(), clock.instant());
		users.saveAndFlush(user);
		sessions.revokeAllFor(id);
		audit.write(actor.id(), "user", id, "deactivated", java.util.Map.of("version", user.getVersion()));
	}

	private void applyBirthday(UserEntity user, Integer day, Integer month, Integer year) {
		var date = birthday(day, month, year);
		user.updateProfile(user.getRealName(), user.getUsername(), date.day, date.month, date.year);
	}

	static Birthday birthday(Integer day, Integer month, Integer year) {
		if (day == null && month == null && year == null) {
			return new Birthday(null, null, null);
		}
		if (day == null || month == null) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_birthday", "День и месяц рождения указываются вместе");
		}
		try {
			MonthDay.of(month, day);
			if (year != null && (year < 1900 || year > LocalDate.now().getYear())) {
				throw new DateTimeException("year");
			}
			if (year != null) {
				LocalDate.of(year, month, day);
			}
			return new Birthday(day, month, year);
		} catch (DateTimeException exception) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_birthday", "Некорректная дата рождения");
		}
	}

	static String normalizeUsername(String username) {
		var normalized = username == null ? "" : username.strip().replaceFirst("^@", "").toLowerCase(Locale.ROOT);
		if (!normalized.matches("[a-zA-Z0-9_]{5,32}")) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_username", "Username должен содержать 5–32 латинских символа, цифры или _");
		}
		return normalized;
	}

	static String normalizeName(String name) {
		var normalized = name == null ? "" : name.strip().replaceAll("\\s+", " ");
		if (normalized.length() < 2 || normalized.length() > 100) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_real_name", "Имя должно содержать 2–100 символов");
		}
		return normalized;
	}

	private UserEntity requireUser(String id) {
		return users.findById(id).orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "user_not_found", "Участник не найден"));
	}

	private void checkVersion(UserEntity user, long expectedVersion) {
		if (user.getVersion() != expectedVersion) {
			throw new ApiException(HttpStatus.CONFLICT, "stale_version", "Профиль уже изменён. Обновите данные.");
		}
	}

	private void lockAndRequireAnotherAdmin(String changingUserId) {
		var activeAdmins = users.findByRoleAndActiveTrue("admin");
		if (activeAdmins.stream().noneMatch(admin -> !admin.getId().equals(changingUserId))) {
			throw new ApiException(HttpStatus.CONFLICT, "last_admin", "Нельзя отключить или понизить последнего администратора");
		}
	}

	private TeamController.UserView view(UserEntity user, boolean includePrivateBirthdayYear) {
		var competencies = jdbc.sql("select competency_id, is_primary from user_competencies where user_id = :userId order by competency_id")
				.param("userId", user.getId())
				.query((row, index) -> new CompetencyAssignment(row.getString("competency_id"), row.getBoolean("is_primary")))
				.list();
		var membership = jdbc.sql("select faculty_id, faculty_role from faculty_memberships where user_id = :userId")
				.param("userId", user.getId())
				.query((row, index) -> new FacultyAssignment(row.getString("faculty_id"), row.getString("faculty_role")))
				.optional();
		return new TeamController.UserView(user.getId(), user.getUsername(), user.getRealName(), user.getRole(),
				user.isRegistered(), user.isActive(), user.getBirthdayDay(), user.getBirthdayMonth(),
				includePrivateBirthdayYear ? user.getBirthdayYear() : null, user.getVersion(), user.getDeactivatedAt(),
				competencies.stream().map(CompetencyAssignment::id).toList(),
				competencies.stream().filter(CompetencyAssignment::primary).map(CompetencyAssignment::id).findFirst().orElse(null),
				membership.map(FacultyAssignment::facultyId).orElse(null),
				membership.map(FacultyAssignment::facultyRole).orElse(null));
	}

	record Birthday(Integer day, Integer month, Integer year) {
	}

	private record CompetencyAssignment(String id, boolean primary) {
	}

	private record FacultyAssignment(String facultyId, String facultyRole) {
	}
}
