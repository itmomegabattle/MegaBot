package ru.itmomegabattle.megabot.tasks;

import static org.assertj.core.api.Assertions.*;
import org.junit.jupiter.api.Test;
import ru.itmomegabattle.megabot.common.ApiException;
import tools.jackson.databind.ObjectMapper;

class LegacyTaskMutationRulesTests {
	private final ObjectMapper json=new ObjectMapper();
	@Test void versionZeroIsRealAndNotReplacedWithLegacyOne() {
		assertThat(LegacyTaskMutationService.version(json.readTree("{\"version\":0}"))).isZero();
	}
	@Test void missingNegativeFractionalOverflowOrStringVersionsAreRejected() {
		for(var body:java.util.List.of("{}","{\"version\":null}","{\"version\":-1}","{\"version\":1.5}",
				"{\"version\":\"1\"}","{\"version\":9223372036854775808}"))
			assertThatThrownBy(()->LegacyTaskMutationService.version(json.readTree(body))).isInstanceOf(ApiException.class);
	}
	@Test void taskIdRequiresAnObjectAndStringNotCoercion() {
		assertThat(LegacyTaskMutationService.id(json.readTree("{\"taskId\":\"task_1\"}"))).isEqualTo("task_1");
		for(var body:java.util.List.of("[]","{}","{\"taskId\":5}","{\"taskId\":null}","{\"taskId\":\"\"}"))
			assertThatThrownBy(()->LegacyTaskMutationService.id(json.readTree(body))).isInstanceOf(ApiException.class);
	}
}
