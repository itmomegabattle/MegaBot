package ru.itmomegabattle.megabot.telegram;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.io.IOException;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import jakarta.servlet.ServletInputStream;
import ru.itmomegabattle.megabot.common.ApiException;

class TelegramWebhookBoundaryTests {
	static final String SECRET="fixture_secret_01234567890123456789";
	@Test void disabledAndUnauthenticatedRequestsNeverReadBodyOrCallInbox() {
		var inbox=mock(TelegramInbox.class);
		var request=new MockHttpServletRequest() {
			@Override public ServletInputStream getInputStream() { throw new AssertionError("body must not be read"); }
		};
		assertThatThrownBy(()->new TelegramWebhookController(inbox,"disabled","","").receive(request))
				.isInstanceOfSatisfying(ApiException.class,e->assertThat(e.code()).isEqualTo("telegram_webhook_disabled"));
		assertThatThrownBy(()->new TelegramWebhookController(inbox,"webhook","123",SECRET).receive(request))
				.isInstanceOfSatisfying(ApiException.class,e->assertThat(e.code()).isEqualTo("invalid_webhook_secret"));
		verifyNoInteractions(inbox);
	}
	@Test void unknownLengthBodyIsBoundedAndReadFailureDoesNotAck() {
		var inbox=mock(TelegramInbox.class);var controller=new TelegramWebhookController(inbox,"webhook","123",SECRET);
		var request=new MockHttpServletRequest() { @Override public long getContentLengthLong() { return -1; } };
		request.addHeader(TelegramWebhookController.SECRET_HEADER,SECRET);request.setContent(new byte[TelegramInbox.MAX_UPDATE_BYTES+1]);
		assertThatThrownBy(()->controller.receive(request)).isInstanceOfSatisfying(ApiException.class,e->assertThat(e.code()).isEqualTo("telegram_update_too_large"));
		// ServletInputStream read itself reports checked IOException.
		var stream=mock(ServletInputStream.class);var ioRequest=mock(jakarta.servlet.http.HttpServletRequest.class);
		when(ioRequest.getHeaders(TelegramWebhookController.SECRET_HEADER)).thenReturn(java.util.Collections.enumeration(java.util.List.of(SECRET)));
		try { when(ioRequest.getInputStream()).thenReturn(stream);when(stream.readNBytes(anyInt())).thenThrow(new IOException("SECRET_IO")); } catch(IOException impossible) { throw new AssertionError(impossible); }
		assertThatThrownBy(()->controller.receive(ioRequest)).isInstanceOfSatisfying(ApiException.class,e->{assertThat(e.code()).isEqualTo("telegram_webhook_unavailable");assertThat(e.getCause()).isNull();});
		verifyNoInteractions(inbox);
	}
	@Test void invalidConfigurationFailsClosedWithoutEchoingSecrets() {
		var inbox=mock(TelegramInbox.class);
		assertThatThrownBy(()->new TelegramWebhookController(inbox,"polling","123",SECRET)).hasMessage("Unsupported Telegram incoming mode");
		assertThatThrownBy(()->new TelegramWebhookController(inbox,"webhook","123","")).hasMessage("Webhook requires configured bot ID and strong secret");
		assertThatThrownBy(()->new TelegramWebhookController(inbox,"webhook","123:SECRET_TOKEN",SECRET)).hasMessage("Webhook requires configured bot ID and strong secret");
	}
}
