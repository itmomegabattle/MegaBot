package ru.itmomegabattle.megabot.telegram;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.TransactionException;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.itmomegabattle.megabot.common.ApiException;

@RestController
class TelegramWebhookController {
	static final String SECRET_HEADER="X-Telegram-Bot-Api-Secret-Token";
	private final TelegramInbox inbox;
	private final boolean enabled;
	private final String botId;
	private final byte[] secret;
	TelegramWebhookController(TelegramInbox inbox,
			@Value("${megabot.telegram.incoming-mode:disabled}") String mode,
			@Value("${megabot.telegram.bot-id:}") String botId,
			@Value("${megabot.telegram.webhook-secret:}") String secret) {
		if(!mode.equals("disabled") && !mode.equals("webhook")) throw new IllegalStateException("Unsupported Telegram incoming mode");
		this.enabled=mode.equals("webhook");
		if(enabled && (!botId.matches("[1-9][0-9]{0,19}") || !secret.matches("[A-Za-z0-9_-]{32,256}")))
			throw new IllegalStateException("Webhook requires configured bot ID and strong secret");
		this.inbox=inbox;this.botId=botId;this.secret=secret.getBytes(StandardCharsets.US_ASCII);
	}
	@PostMapping(value="/api/v1/telegram/webhook",consumes="application/json")
	ResponseEntity<Void> receive(HttpServletRequest request) {
		if(!enabled) throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,"telegram_webhook_disabled","Приём Telegram updates выключен");
		var headers=Collections.list(request.getHeaders(SECRET_HEADER));
		if(headers.size()!=1 || !headers.getFirst().matches("[A-Za-z0-9_-]{32,256}")
				|| !MessageDigest.isEqual(secret,headers.getFirst().getBytes(StandardCharsets.US_ASCII)))
			throw new ApiException(HttpStatus.UNAUTHORIZED,"invalid_webhook_secret","Неверная авторизация webhook");
		// Authenticate before reading; cap even chunked/unknown Content-Length bodies.
		if(request.getContentLengthLong()>TelegramInbox.MAX_UPDATE_BYTES) throw tooLarge();
		try {
			var payload=request.getInputStream().readNBytes(TelegramInbox.MAX_UPDATE_BYTES+1);
			if(payload.length>TelegramInbox.MAX_UPDATE_BYTES) throw tooLarge();
			inbox.accept(botId,payload); // Spring proxy commits before ack, including duplicates.
			return ResponseEntity.ok().header("Cache-Control","no-store").build();
		} catch(IOException | DataAccessException | TransactionException unavailable) {
			throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,"telegram_webhook_unavailable","Приём Telegram updates временно недоступен");
		}
	}
	private static ApiException tooLarge() {
		return new ApiException(HttpStatus.PAYLOAD_TOO_LARGE,"telegram_update_too_large","Telegram update превышает допустимый размер");
	}
}
