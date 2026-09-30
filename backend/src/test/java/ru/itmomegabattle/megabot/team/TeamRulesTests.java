package ru.itmomegabattle.megabot.team;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.itmomegabattle.megabot.common.ApiException;

class TeamRulesTests {

	@Test
	void normalizesTelegramUsernameWithoutAtSign() {
		assertThat(TeamService.normalizeUsername(" @Some_User ")).isEqualTo("some_user");
	}

	@Test
	void rejectsIncompleteOrImpossibleBirthday() {
		assertThatThrownBy(() -> TeamService.birthday(12, null, null)).isInstanceOf(ApiException.class);
		assertThatThrownBy(() -> TeamService.birthday(29, 2, 2025)).isInstanceOf(ApiException.class);
		assertThat(TeamService.birthday(29, 2, 2024).year()).isEqualTo(2024);
	}

	@Test
	void distinguishesCoreAndFacultyRoles() {
		assertThat(TeamRole.ADMIN.isCore()).isTrue();
		assertThat(TeamRole.ORGANIZER.isCore()).isTrue();
		assertThat(TeamRole.FACULTY_RESPONSIBLE.isCore()).isFalse();
		assertThatThrownBy(() -> TeamRole.parse("owner")).isInstanceOf(ApiException.class);
	}
}
