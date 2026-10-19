package ru.itmomegabattle.megabot.notifications;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.Flow;
import tools.jackson.databind.ObjectMapper;

/** Credentials stay private: never expose request URI, exception text or provider description in logs/results. */
public final class TelegramHttpTransport implements TelegramTransport {
	private final HttpClient http;
	private final ObjectMapper json;
	private final URI endpoint;
	private final Duration timeout;
	private final Set<Long> allowedPrivateChats;
	public TelegramHttpTransport(ObjectMapper json,String token,Duration timeout) {
		this(json,endpoint(token),timeout);
	}
	TelegramHttpTransport(ObjectMapper json,String token,Duration timeout,long expectedBotId,Set<Long> allowedPrivateChats) {
		this(json,endpoint(token),timeout,allowedPrivateChats);
		if(expectedBotId<=0 || allowedPrivateChats==null)throw new IllegalArgumentException("invalid_test_boundary");
		if(!token.startsWith(expectedBotId+":"))throw new IllegalArgumentException("unexpected_test_bot_credentials");
	}
	// Package-private endpoint override is only for local HTTP fixtures, never from environment/user payload.
	TelegramHttpTransport(ObjectMapper json,URI endpoint,Duration timeout) {
		this(json,endpoint,timeout,null);
	}
	TelegramHttpTransport(ObjectMapper json,URI endpoint,Duration timeout,Set<Long> allowedPrivateChats) {
		if(timeout==null || timeout.compareTo(Duration.ofMillis(100))<0 || timeout.compareTo(Duration.ofSeconds(15))>0)
			throw new IllegalArgumentException("invalid_telegram_timeout");
		this.json=json;this.endpoint=endpoint;this.timeout=timeout;
		if(allowedPrivateChats!=null && (allowedPrivateChats.isEmpty() || allowedPrivateChats.stream().anyMatch(id->id==null || id<=0)))
			throw new IllegalArgumentException("invalid_test_recipients");
		this.allowedPrivateChats=allowedPrivateChats==null?null:Set.copyOf(allowedPrivateChats);
		http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).version(HttpClient.Version.HTTP_1_1).build();
	}
	private static URI endpoint(String token) {
		if(token==null || !token.matches("[0-9]+:[A-Za-z0-9_-]{20,}"))throw new IllegalArgumentException("invalid_telegram_credentials");
		return URI.create("https://api.telegram.org/bot"+token+"/sendMessage");
	}
	@Override public Outcome send(Message message) {
		if(allowedPrivateChats!=null && (!allowedPrivateChats.contains(message.chatId()) || message.threadId()!=null))
			return Outcome.failed("test_recipient_not_allowed");
		var body=new LinkedHashMap<String,Object>();body.put("chat_id",message.chatId());body.put("text",message.text());body.put("disable_notification",message.silent());
		if(message.threadId()!=null)body.put("message_thread_id",message.threadId());
		if(message.keyboard()!=null)body.put("reply_markup",message.keyboard().markup());
		if(message.inlineKeyboard()!=null)body.put("reply_markup",message.inlineKeyboard().markup());
		return request(endpoint,body,message.chatId(),null,false);
	}
	@Override public Outcome edit(Edit edit) {
		if(allowedPrivateChats!=null && !allowedPrivateChats.contains(edit.chatId()))return Outcome.failed("test_recipient_not_allowed");
		return request(endpoint.resolve("editMessageText"),java.util.Map.of("chat_id",edit.chatId(),"message_id",edit.messageId(),
				"text",edit.text(),"reply_markup",edit.keyboard().markup()),edit.chatId(),edit.messageId(),false);
	}
	@Override public Outcome acknowledge(Acknowledgement ack) {
		if(allowedPrivateChats!=null && !allowedPrivateChats.contains(ack.chatId()))return Outcome.failed("test_recipient_not_allowed");
		return request(endpoint.resolve("answerCallbackQuery"),java.util.Map.of("callback_query_id",ack.callbackId(),"text",ack.text(),
				"show_alert",false,"cache_time",0),ack.chatId(),null,true);
	}
	@Override public Outcome delete(Deletion deletion) {
		if(allowedPrivateChats!=null && !allowedPrivateChats.contains(deletion.chatId()))return Outcome.failed("test_recipient_not_allowed");
		return request(endpoint.resolve("deleteMessage"),java.util.Map.of("chat_id",deletion.chatId(),"message_id",deletion.messageId()),
				deletion.chatId(),null,true);
	}
	private Outcome request(URI uri,java.util.Map<String,?> body,long chatId,Long expectedId,boolean booleanResult) {
		try {
			var request=HttpRequest.newBuilder(uri).timeout(timeout).header("Content-Type","application/json")
					.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
			var pending=http.sendAsync(request,info->new LimitedBody());
			try {
				var response=pending.get(timeout.toMillis(),TimeUnit.MILLISECONDS);
				if(booleanResult) {
					var root=json.readTree(response.body());
					if(root!=null && root.path("ok").isBoolean() && root.path("ok").booleanValue())
						return response.statusCode()==200 && root.path("result").isBoolean() && root.path("result").booleanValue()
								?Outcome.acknowledged():Outcome.unknown("invalid_boolean_response");
				}
				var result=classify(response.statusCode(),response.body(),chatId);
				return expectedId!=null && result.kind()==Kind.SENT && !expectedId.equals(result.messageId())
						?Outcome.unknown("unexpected_edited_message"):result;
			}catch(TimeoutException e) { pending.cancel(true);return Outcome.unknown("response_timeout"); }
			catch(InterruptedException e) { pending.cancel(true);Thread.currentThread().interrupt();return Outcome.unknown("interrupted_after_start"); }
			catch(ExecutionException e) {
				for(Throwable cause=e;cause!=null;cause=cause.getCause())if(cause instanceof HttpConnectTimeoutException || cause instanceof ConnectException || cause instanceof UnknownHostException)
					return Outcome.retry("connection_not_established",null);
				return Outcome.unknown("response_not_confirmed");
			}
		}catch(RuntimeException e) {
			// Includes timeout, lost/truncated response, TLS/HTTP protocol errors: delivery might have been accepted.
			return Outcome.unknown("response_not_confirmed");
		}
	}
	Outcome classify(int status,byte[] bytes,long chatId) {
		try {
			var root=json.readTree(bytes);
			if(root==null || !root.isObject() || !root.path("ok").isBoolean())return Outcome.unknown("invalid_provider_response");
			if(root.path("ok").asBoolean()) {
				var id=root.path("result").path("message_id");var chat=root.path("result").path("chat").path("id");
				if(status==200 && id.isIntegralNumber() && id.canConvertToLong() && id.asLong()>0 && chat.isIntegralNumber() && chat.canConvertToLong() && chat.asLong()==chatId)
					return Outcome.sent(id.asLong());
				return Outcome.unknown("invalid_success_response");
			}
			var error=root.path("error_code");if(!error.isIntegralNumber() || !error.canConvertToInt())return Outcome.unknown("invalid_provider_response");
			var code=error.asInt();if(status!=code && status!=200)return Outcome.unknown("inconsistent_provider_response");
			if(code==429) {
				var delay=root.path("parameters").path("retry_after");
				if(!delay.isMissingNode() && (!delay.isIntegralNumber() || !delay.canConvertToLong() || delay.asLong()<0 || delay.asLong()>365L*86400))return Outcome.unknown("invalid_retry_after");
				return Outcome.retry("telegram_429",delay.isMissingNode()?null:Duration.ofSeconds(Math.max(1,delay.asLong())));
			}
			if(code==400 || code==401 || code==403 || code==404)return Outcome.failed("telegram_"+code);
			if(code>=500 && code<=599)return Outcome.retry("telegram_"+code,null);
			return Outcome.unknown("unclassified_provider_response");
		}catch(RuntimeException e) { return Outcome.unknown("invalid_provider_response"); }
	}
	private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
		private final HttpResponse.BodySubscriber<byte[]> delegate=HttpResponse.BodySubscribers.ofByteArray();
		private Flow.Subscription subscription;private long bytes;
		public CompletionStage<byte[]> getBody() { return delegate.getBody(); }
		public void onSubscribe(Flow.Subscription s) { subscription=s;delegate.onSubscribe(s); }
		public void onNext(List<ByteBuffer> buffers) {
			for(var b:buffers)bytes+=b.remaining();
			if(bytes>65536) { subscription.cancel();delegate.onError(new IOException("provider_response_too_large")); }else delegate.onNext(buffers);
		}
		public void onError(Throwable e) { delegate.onError(e); }
		public void onComplete() { delegate.onComplete(); }
	}
}
