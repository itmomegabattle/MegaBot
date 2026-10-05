package ru.itmomegabattle.megabot;

import static org.assertj.core.api.Assertions.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

class OpenApiContractTests {
	@Test void contractParsesAndEveryLocalReferenceResolvesIncludingDiagnostics() throws Exception {
		Map<String,Object> contract=new Yaml().load(Files.readString(Path.of("openapi.yaml")));
		assertThat(contract.get("openapi")).isEqualTo("3.1.0");
		assertThat(((Map<?,?>)contract.get("paths")).containsKey("/api/v1/admin/delivery-diagnostics")).isTrue();
		assertThat(((Map<?,?>)contract.get("paths")).containsKey("/api/v1/telegram/webhook")).isTrue();
		var components=(Map<?,?>)contract.get("components");
		assertThat(((Map<?,?>)components.get("securitySchemes")).containsKey("telegramWebhookSecret")).isTrue();
		assertThat(((Map<?,?>)contract.get("paths")).containsKey("/api/team/broadcast")).isTrue();
		assertThat(((Map<?,?>)contract.get("paths")).containsKey("/api/v1/admin/broadcast-group-targets")).isTrue();
		checkReferences(contract,contract);
	}
	private void checkReferences(Object node,Map<String,Object> contract) {
		if(node instanceof Map<?,?> map) {
			if(map.get("$ref") instanceof String ref) {
				assertThat(ref).startsWith("#/");Object target=contract;
				for(String part:ref.substring(2).split("/")) {
					assertThat(target).as(ref).isInstanceOf(Map.class);
					target=((Map<?,?>)target).get(part.replace("~1","/").replace("~0","~"));
					assertThat(target).as(ref).isNotNull();
				}
			}map.values().forEach(value->checkReferences(value,contract));
		}else if(node instanceof Iterable<?> items)items.forEach(value->checkReferences(value,contract));
	}
}
