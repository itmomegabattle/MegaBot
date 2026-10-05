package ru.itmomegabattle.megabot.telegram;

import java.time.Duration;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Manual/local consumer only. No scheduler or live incoming switch until command/menu parity exists. */
@Service
public class TelegramCommandWorker {
	private final TelegramInboxQueue queue;private final TelegramPrivateCommandHandler commands;
	TelegramCommandWorker(TelegramInboxQueue queue,TelegramPrivateCommandHandler commands) { this.queue=queue;this.commands=commands; }
	public boolean processOne(String botId) {
		if(TransactionSynchronizationManager.isActualTransactionActive()) throw new IllegalStateException("inbox_worker_requires_no_transaction");
		var leases=queue.claim(botId,1,Duration.ofSeconds(30));if(leases.isEmpty()) return false;
		var lease=leases.getFirst();
		try { queue.apply(lease.id(),lease.token(),commands::handle); }
		catch(TelegramPrivateCommandHandler.UnsupportedCommand e) { queue.reject(lease.id(),lease.token(),"unsupported_command",Duration.ofHours(1)); }
		catch(TelegramPrivateCommandHandler.InvalidPrivateCommand e) { queue.reject(lease.id(),lease.token(),"invalid_private_command",null); }
		catch(RuntimeException e) {
			queue.reject(lease.id(),lease.token(),"command_processing_failed",Duration.ofSeconds(Math.min(300,5L*lease.attempts())));
		}
		return true; // Work inspected, not a claim of successful command or provider delivery.
	}
}
