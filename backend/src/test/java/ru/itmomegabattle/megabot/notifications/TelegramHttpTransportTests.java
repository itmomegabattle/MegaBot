package ru.itmomegabattle.megabot.notifications;

import static org.assertj.core.api.Assertions.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class TelegramHttpTransportTests {
	final ObjectMapper json=new ObjectMapper();
	final TelegramTransport.Message message=new TelegramTransport.Message(-100L,9L,"Текст <без HTML>",true);
	TelegramHttpTransport client(URI uri,Duration timeout) { return new TelegramHttpTransport(json,uri,timeout); }
	TelegramTransport.Outcome classify(int status,String body) { return client(URI.create("http://127.0.0.1/"),Duration.ofSeconds(1)).classify(status,body.getBytes(StandardCharsets.UTF_8),-100L); }
	@Test void successRequiresMatchingChatAndPositiveProviderMessageId() {
		assertThat(classify(200,"{\"ok\":true,\"result\":{\"message_id\":123,\"chat\":{\"id\":-100}}}").messageId()).isEqualTo(123L);
		for(var body:new String[]{"{\"ok\":true}","{\"ok\":true,\"result\":{\"message_id\":0,\"chat\":{\"id\":-100}}}","{\"ok\":true,\"result\":{\"message_id\":123,\"chat\":{\"id\":1}}}"})
			assertThat(classify(200,body).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
	}
	@Test void explicitRefusalsAreSeparatedFromAmbiguousGatewayErrors() {
		assertThat(classify(403,"{\"ok\":false,\"error_code\":403,\"description\":\"secret raw details\"}").code()).isEqualTo("telegram_403");
		assertThat(classify(400,"{\"ok\":false,\"error_code\":400}").kind()).isEqualTo(TelegramTransport.Kind.FAILED);
		assertThat(classify(503,"{\"ok\":false,\"error_code\":503}").kind()).isEqualTo(TelegramTransport.Kind.RETRY);
		assertThat(classify(503,"gateway error").kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
		assertThat(classify(200,"{\"ok\":false,\"error_code\":429,\"parameters\":{\"retry_after\":40}}").retryAfter()).isEqualTo(Duration.ofSeconds(40));
		assertThat(classify(429,"{\"ok\":false,\"error_code\":429,\"parameters\":{\"retry_after\":-1}}").kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
		assertThat(classify(500,"{\"ok\":false,\"error_code\":403}").kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
	}
	@Test void realLocalHttpPreservesTopicAndSilentWithoutFormattingOrPaidBroadcast() throws Exception {
		var request=new AtomicReference<String>();var count=new AtomicInteger();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/sendMessage",exchange->{count.incrementAndGet();request.set(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":{\"message_id\":42,\"chat\":{\"id\":-100}}}".getBytes(StandardCharsets.UTF_8);
			exchange.sendResponseHeaders(200,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();});server.start();
		try {
			var outcome=client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/sendMessage"),Duration.ofSeconds(2)).send(message);
			assertThat(outcome.kind()).isEqualTo(TelegramTransport.Kind.SENT);assertThat(count).hasValue(1);
			var body=json.readTree(request.get());assertThat(body.path("chat_id").asLong()).isEqualTo(-100L);assertThat(body.path("message_thread_id").asLong()).isEqualTo(9);
			assertThat(body.path("disable_notification").asBoolean()).isTrue();assertThat(body.path("text").asText()).isEqualTo(message.text());
			assertThat(body.has("parse_mode")).isFalse();assertThat(body.has("allow_paid_broadcast")).isFalse();assertThat(body.has("reply_markup")).isFalse();
		}finally { server.stop(0); }
	}
	@Test void acceptedRequestWithLostOrSlowBodyIsUnknownAndNeverRetried() throws Exception {
		var count=new AtomicInteger();var releaseBody=new CountDownLatch(1);var executor=Executors.newCachedThreadPool();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.setExecutor(executor);
		server.createContext("/",exchange->{count.incrementAndGet();exchange.getRequestBody().readAllBytes();exchange.sendResponseHeaders(200,1000);
			try { releaseBody.await();exchange.getResponseBody().write('x'); }catch(Exception ignored) {}finally { exchange.close(); }});server.start();
		try {
			// Allow cold local HTTP setup; the body stays blocked until the client has timed out.
			var outcome=client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/"),Duration.ofSeconds(2)).send(message);
			assertThat(outcome.kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);assertThat(count).hasValue(1);
		}finally { releaseBody.countDown();server.stop(0);executor.shutdownNow(); }
	}
	@Test void refusedConnectionIsSafeRetryWithoutLeakingEndpoint() throws Exception {
		int port;try(var socket=new ServerSocket(0)) { port=socket.getLocalPort(); }
		var outcome=client(URI.create("http://127.0.0.1:"+port+"/secret-token/"),Duration.ofSeconds(2)).send(message);
		assertThat(outcome.kind()).isEqualTo(TelegramTransport.Kind.RETRY);assertThat(outcome.toString()).doesNotContain("secret-token","127.0.0.1");
	}
	@Test void redirectsAreNotFollowedAndOversizedResponsesAreUnknown() throws Exception {
		var redirected=new AtomicInteger();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/redirect",e->{e.getResponseHeaders().add("Location","/target");e.sendResponseHeaders(302,-1);e.close();});
		server.createContext("/target",e->{redirected.incrementAndGet();e.sendResponseHeaders(200,-1);e.close();});
		server.createContext("/large",e->{byte[] bytes=new byte[70000];e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var base="http://127.0.0.1:"+server.getAddress().getPort();
			assertThat(client(URI.create(base+"/redirect"),Duration.ofSeconds(2)).send(message).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);assertThat(redirected).hasValue(0);
			assertThat(client(URI.create(base+"/large"),Duration.ofSeconds(2)).send(message).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
		}finally { server.stop(0); }
	}
	@Test void invalidCredentialsAndPayloadsAreRejectedBeforeNetwork() {
		assertThatThrownBy(()->new TelegramHttpTransport(json,"secret/path",Duration.ofSeconds(8))).hasMessage("invalid_telegram_credentials");
		assertThatThrownBy(()->new TelegramTransport.Message(0,null,"text",false)).isInstanceOf(IllegalArgumentException.class);
		assertThatThrownBy(()->new TelegramTransport.Message(1,null,"x".repeat(4001),false)).isInstanceOf(IllegalArgumentException.class);
	}
	@Test void privateTextKeyboardIsSerializedThroughExistingHttpBoundary() throws Exception {
		var request=new AtomicReference<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/",e->{request.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":{\"message_id\":7,\"chat\":{\"id\":42}}}".getBytes(StandardCharsets.UTF_8);
			e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var keyboard=new TelegramTransport.ReplyKeyboard(java.util.List.of(java.util.List.of("Задачи","Помощь")));
			var outcome=client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/"),Duration.ofSeconds(2))
					.send(new TelegramTransport.Message(42,null,"Меню",false,keyboard));
			assertThat(outcome.kind()).isEqualTo(TelegramTransport.Kind.SENT);
			var body=json.readTree(request.get());assertThat(body.path("reply_markup")).isEqualTo(json.valueToTree(keyboard.markup()));
			assertThat(body.has("parse_mode")).isFalse();assertThat(body.has("message_thread_id")).isFalse();
		}finally { server.stop(0); }
	}
	@Test void keyboardIsImmutableBoundedAndRejectsPrivilegedFieldsOrNonPrivateTargets() {
		var row=new java.util.ArrayList<>(java.util.List.of("Помощь"));var rows=new java.util.ArrayList<java.util.List<String>>();rows.add(row);
		var keyboard=new TelegramTransport.ReplyKeyboard(rows);row.add("МФ");rows.clear();assertThat(keyboard.rows()).containsExactly(java.util.List.of("Помощь"));
		assertThatThrownBy(()->keyboard.rows().getFirst().add("МФ")).isInstanceOf(UnsupportedOperationException.class);
		assertThatThrownBy(()->new TelegramTransport.Message(-100,null,"text",false,keyboard)).hasMessage("invalid_keyboard_target");
		assertThatThrownBy(()->new TelegramTransport.Message(42,1L,"text",false,keyboard)).hasMessage("invalid_keyboard_target");
		for(var markup:java.util.List.of("{}","null","{\"keyboard\":[]}",
				"{\"keyboard\":[[{\"text\":\"Help\",\"request_contact\":true}]],\"resize_keyboard\":true,\"is_persistent\":false,\"one_time_keyboard\":false}"))
			assertThatThrownBy(()->TelegramTransport.ReplyKeyboard.parse(json.readTree(markup))).hasMessage("invalid_reply_keyboard");
		for(var invalid:java.util.List.of(java.util.List.<java.util.List<String>>of(),java.util.List.of(java.util.List.of(" ")),java.util.List.of(java.util.List.of("x".repeat(129)))))
			assertThatThrownBy(()->new TelegramTransport.ReplyKeyboard(invalid)).hasMessage("invalid_reply_keyboard");
	}
	@Test void restrictedTransportBlocksOtherUsersGroupsAndTopicsBeforeAnyHttp() throws Exception {
		var count=new AtomicInteger();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/",e->{count.incrementAndGet();
			var request=json.readTree(e.getRequestBody().readAllBytes());
			var bytes=("{\"ok\":true,\"result\":{\"message_id\":42,\"chat\":{\"id\":"+request.path("chat_id").asLong()+"}}}").getBytes(StandardCharsets.UTF_8);
			e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var recipients=new java.util.HashSet<>(LiveTestSafetyConfiguration.RECIPIENTS);
			var transport=new TelegramHttpTransport(json,URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/"),Duration.ofSeconds(2),recipients);
			recipients.add(999L); // The boundary is an immutable copy, not a caller-owned mutable set.
			for(var blocked:new TelegramTransport.Message[]{new TelegramTransport.Message(999,null,"test",true),message,
					new TelegramTransport.Message(658274366L,1L,"test",true)}) {
				assertThat(transport.send(blocked).code()).isEqualTo("test_recipient_not_allowed");
				assertThat(count).hasValue(0);
			}
			for(var id:LiveTestSafetyConfiguration.RECIPIENTS)
				assertThat(transport.send(new TelegramTransport.Message(id,null,"test",true)).kind()).isEqualTo(TelegramTransport.Kind.SENT);
			assertThat(count).hasValue(2);
		}finally { server.stop(0); }
	}
	@Test void restrictedCredentialsAndRecipientConfigurationFailClosed() {
		assertThatThrownBy(()->new TelegramHttpTransport(json,"111:"+"x".repeat(25),Duration.ofSeconds(2),LiveTestSafetyConfiguration.BOT_ID,LiveTestSafetyConfiguration.RECIPIENTS))
				.hasMessage("unexpected_test_bot_credentials");
		for(var ids:java.util.List.of(java.util.Set.<Long>of(),java.util.Set.of(-1L),java.util.Set.of(0L)))
			assertThatThrownBy(()->new TelegramHttpTransport(json,LiveTestSafetyConfigurationTests.TOKEN,Duration.ofSeconds(2),LiveTestSafetyConfiguration.BOT_ID,ids))
				.hasMessage("invalid_test_recipients");
		assertThatThrownBy(()->new TelegramHttpTransport(json,LiveTestSafetyConfigurationTests.TOKEN,Duration.ofSeconds(2),LiveTestSafetyConfiguration.BOT_ID,null))
				.hasMessage("invalid_test_boundary");
	}
}
