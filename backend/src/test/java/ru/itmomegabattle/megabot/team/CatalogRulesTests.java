package ru.itmomegabattle.megabot.team;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.itmomegabattle.megabot.common.ApiException;

class CatalogRulesTests {

	@Test
	void validatesCatalogScopesAndFacultyRoles() {
		assertThat(CatalogService.normalizeScope("CORE")).isEqualTo("core");
		assertThat(CatalogService.normalizeFacultyRole("Responsible")).isEqualTo("responsible");
		assertThatThrownBy(() -> CatalogService.normalizeScope("all")).isInstanceOf(ApiException.class);
		assertThatThrownBy(() -> CatalogService.normalizeFacultyRole("admin")).isInstanceOf(ApiException.class);
	}

	@Test
	void normalizesCatalogNames() {
		assertThat(CatalogService.normalizeName("  Event   management ", "Name"))
				.isEqualTo("Event management");
	}
}
