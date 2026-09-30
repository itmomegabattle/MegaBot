package ru.itmomegabattle.megabot.compatibility;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class FrontendStateMappingTests {

	@Test
	void hidesBirthdayYearFromOtherMembers() {
		assertThat(FrontendStateService.birthday(7, 3, 2001, false)).isEqualTo("07.03");
		assertThat(FrontendStateService.birthday(7, 3, 2001, true)).isEqualTo("2001-03-07");
		assertThat(FrontendStateService.birthday(null, null, null, true)).isEmpty();
	}
}
