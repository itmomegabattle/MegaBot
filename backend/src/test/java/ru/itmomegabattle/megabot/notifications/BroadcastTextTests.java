package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class BroadcastTextTests {
	@Test void boundariesAndExactReconstructionPreserveEveryCharacter() {
		for(var text:List.of("x","x".repeat(4000),"x".repeat(4001),"x".repeat(40000),"заголовок\n\n"+"строка\n".repeat(1100))) {
			var parts=BroadcastText.split(text);assertThat(String.join("",parts)).isEqualTo(text);
			assertThat(parts).allSatisfy(p->assertThat(p.length()).isBetween(1,4000));
		}
		assertThat(BroadcastText.split("x".repeat(4000))).hasSize(1);assertThat(BroadcastText.split("x".repeat(4001))).hasSize(2);
	}
	@Test void neverBreaksEmojiGraphemesCombiningMarksCrLfOrLiteralEntities() {
		for(var unit:List.of("👨‍👩‍👧‍👦","🇷🇺","е\u0301","💙","\r\n","&amp;","&#128153;","&#x1F499;")) {
			var text="x".repeat(3999)+unit+"tail";var parts=BroadcastText.split(text);
			assertThat(String.join("",parts)).isEqualTo(text);assertThat(parts.get(1)).startsWith(unit);
		}
	}
	@Test void invalidOversizeUndividableOrBlankPartsAreRejectedBeforeQueueing() {
		for(var text:List.of(" ","x".repeat(40001),"a"+"\u0301".repeat(4000),"x"+" ".repeat(9000)+"y","x\uD800y"))
			assertThatThrownBy(()->BroadcastText.split(text)).isInstanceOf(ru.itmomegabattle.megabot.common.ApiException.class);
	}
}
