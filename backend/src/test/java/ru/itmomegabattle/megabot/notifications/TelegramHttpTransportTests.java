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
	@Test void deleteUsesExactPrivateTargetAndRequiresBooleanConfirmation() throws Exception {
		var response=new AtomicReference<>("{\"ok\":true,\"result\":true}");var request=new AtomicReference<String>();var calls=new AtomicInteger();
		var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/botfixture/deleteMessage",e->{calls.incrementAndGet();request.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes=response.get().getBytes(StandardCharsets.UTF_8);e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var client=new TelegramHttpTransport(json,URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/botfixture/sendMessage"),Duration.ofSeconds(2),java.util.Set.of(42L));
			var outcome=client.delete(new TelegramTransport.Deletion(42,11));assertThat(outcome.kind()).isEqualTo(TelegramTransport.Kind.SENT);assertThat(outcome.messageId()).isNull();
			var body=json.readTree(request.get());assertThat(body.size()).isEqualTo(2);assertThat(body.path("chat_id").asLong()).isEqualTo(42);assertThat(body.path("message_id").asLong()).isEqualTo(11);
			assertThat(client.delete(new TelegramTransport.Deletion(43,11)).code()).isEqualTo("test_recipient_not_allowed");assertThat(calls.get()).isEqualTo(1);
			assertThatThrownBy(()->new TelegramTransport.Deletion(-100,11)).isInstanceOf(IllegalArgumentException.class);
			assertThatThrownBy(()->new TelegramTransport.Deletion(42,0)).isInstanceOf(IllegalArgumentException.class);
			for(var value:java.util.List.of("{\"ok\":true,\"result\":false}","{\"ok\":true,\"result\":1}","{\"ok\":true}","garbage")) {
				response.set(value);assertThat(client.delete(new TelegramTransport.Deletion(42,11)).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
			}
			response.set("{\"ok\":false,\"error_code\":429,\"parameters\":{\"retry_after\":4}}");assertThat(client.delete(new TelegramTransport.Deletion(42,11)).retryAfter()).isEqualTo(Duration.ofSeconds(4));
			response.set("{\"ok\":false,\"error_code\":400}");assertThat(client.delete(new TelegramTransport.Deletion(42,11)).kind()).isEqualTo(TelegramTransport.Kind.FAILED);
		} finally {server.stop(0);}
	}
	@Test void privateEditAndAckUseExactMethodsAndDoNotInventProviderIds() throws Exception {
		var edits=new AtomicReference<String>();var acks=new AtomicReference<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/botfixture/editMessageText",e->{edits.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":{\"message_id\":11,\"chat\":{\"id\":42}}}".getBytes(StandardCharsets.UTF_8);e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});
		server.createContext("/botfixture/answerCallbackQuery",e->{acks.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":true}".getBytes(StandardCharsets.UTF_8);e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var client=client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/botfixture/sendMessage"),Duration.ofSeconds(2));
			var keyboard=new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("Неделя","week:1"))));
			assertThat(client.edit(new TelegramTransport.Edit(42,11,"Выбери неделю",keyboard)).messageId()).isEqualTo(11);
			var edit=json.readTree(edits.get());assertThat(edit.size()).isEqualTo(4);assertThat(edit.path("message_id").asLong()).isEqualTo(11);assertThat(edit.has("disable_notification")).isFalse();assertThat(edit.has("message_thread_id")).isFalse();
			var ack=client.acknowledge(new TelegramTransport.Acknowledgement(42,"callback-1",""));assertThat(ack.kind()).isEqualTo(TelegramTransport.Kind.SENT);assertThat(ack.messageId()).isNull();
			var body=json.readTree(acks.get());assertThat(body.size()).isEqualTo(4);assertThat(body.path("callback_query_id").asText()).isEqualTo("callback-1");assertThat(body.path("cache_time").asInt()).isZero();assertThat(body.path("show_alert").asBoolean()).isFalse();assertThat(body.has("chat_id")).isFalse();
		}finally {server.stop(0);}
	}
	@Test void editRequiresExactMessageAndAckRequiresBooleanTrue() throws Exception {
		var response=new AtomicReference<>("{\"ok\":true,\"result\":{\"message_id\":12,\"chat\":{\"id\":42}}}");
		var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/",e->{e.getRequestBody().readAllBytes();var bytes=response.get().getBytes(StandardCharsets.UTF_8);e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var client=client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/sendMessage"),Duration.ofSeconds(2));
			var keyboard=new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("День","day:1"))));
			assertThat(client.edit(new TelegramTransport.Edit(42,11,"Текст",keyboard)).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);
			for(var body:java.util.List.of("{\"ok\":true,\"result\":false}","{\"ok\":true,\"result\":1}","{\"ok\":true}","garbage")) {response.set(body);assertThat(client.acknowledge(new TelegramTransport.Acknowledgement(42,"callback","text")).kind()).isEqualTo(TelegramTransport.Kind.UNKNOWN);}
			response.set("{\"ok\":false,\"error_code\":429,\"parameters\":{\"retry_after\":4}}");assertThat(client.acknowledge(new TelegramTransport.Acknowledgement(42,"callback","text")).retryAfter()).isEqualTo(Duration.ofSeconds(4));
		}finally {server.stop(0);}
	}
	@Test void editAndAckRespectPrivateAllowlistAndStrictTypesBeforeHttp() throws Exception {
		var calls=new AtomicInteger();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);server.createContext("/",e->{calls.incrementAndGet();e.sendResponseHeaders(403,-1);e.close();});server.start();
		try {
			var client=new TelegramHttpTransport(json,URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/sendMessage"),Duration.ofSeconds(2),java.util.Set.of(42L));
			var keyboard=new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("День","day:1"))));
			assertThat(client.edit(new TelegramTransport.Edit(43,11,"Text",keyboard)).code()).isEqualTo("test_recipient_not_allowed");
			assertThat(client.acknowledge(new TelegramTransport.Acknowledgement(43,"callback","")).code()).isEqualTo("test_recipient_not_allowed");
			assertThatThrownBy(()->new TelegramTransport.Edit(-100,11,"Text",keyboard)).isInstanceOf(IllegalArgumentException.class);
			assertThatThrownBy(()->new TelegramTransport.Edit(42,0,"Text",keyboard)).isInstanceOf(IllegalArgumentException.class);
			assertThatThrownBy(()->new TelegramTransport.Acknowledgement(42,"callback","x".repeat(201))).isInstanceOf(IllegalArgumentException.class);
			assertThatThrownBy(()->new TelegramTransport.Acknowledgement(42,"\uD800","")).isInstanceOf(IllegalArgumentException.class);
			assertThat(calls.get()).isZero();
		}finally {server.stop(0);}
	}
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
	@Test void forcedReplyKeepsKeyboardRowsThroughStrictParserAndRealLocalHttp() throws Exception {
		var request=new AtomicReference<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/",e->{request.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":{\"message_id\":7,\"chat\":{\"id\":42}}}".getBytes(StandardCharsets.UTF_8);
			e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var rows=java.util.List.of(java.util.List.of("Подтвердить"),java.util.List.of("Меню","Назад"));
			var keyboard=new TelegramTransport.ReplyKeyboard(rows,true);var markup=json.valueToTree(keyboard.markup());
			var message=TelegramTransport.Message.withMarkup(42,null,"Подтверди выбор",false,markup);
			assertThat(message.keyboard()).isEqualTo(keyboard);
			assertThat(client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/"),Duration.ofSeconds(2)).send(message).messageId()).isEqualTo(7);
			var wire=json.readTree(request.get()).path("reply_markup");assertThat(wire).isEqualTo(markup);assertThat(wire.size()).isEqualTo(5);
			assertThat(wire.path("force_reply").booleanValue()).isTrue();assertThat(message.keyboard().rows()).isEqualTo(rows);
			var plain=new TelegramTransport.ReplyKeyboard(rows);assertThat(plain.markup()).hasSize(4).doesNotContainKey("force_reply");
			assertThat(TelegramTransport.ReplyKeyboard.parse(json.valueToTree(plain.markup()))).isEqualTo(plain);
		}finally {server.stop(0);}
	}
	@Test void forcedReplyParserRejectsNonCanonicalFlagsAndExtraFields() {
		var keyboard=new TelegramTransport.ReplyKeyboard(java.util.List.of(java.util.List.of("Назад")),true);
		for(var flag:java.util.List.of("false","null","1","\"true\"")) {
			var markup=(tools.jackson.databind.node.ObjectNode)json.valueToTree(keyboard.markup());markup.set("force_reply",json.readTree(flag));
			assertThatThrownBy(()->TelegramTransport.Message.withMarkup(42,null,"Текст",false,markup)).hasMessage("invalid_reply_keyboard");
		}
		var markup=(tools.jackson.databind.node.ObjectNode)json.valueToTree(keyboard.markup());markup.put("selective",true);
		assertThatThrownBy(()->TelegramTransport.ReplyKeyboard.parse(markup)).hasMessage("invalid_reply_keyboard");
		assertThatThrownBy(()->new TelegramTransport.Message(-100,null,"Текст",false,keyboard)).hasMessage("invalid_keyboard_target");
		assertThatThrownBy(()->new TelegramTransport.Message(42,1L,"Текст",false,keyboard)).hasMessage("invalid_keyboard_target");
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
	@Test void inlineCallbackKeyboardUsesExistingLocalHttpWithExactMarkup() throws Exception {
		var request=new AtomicReference<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
		server.createContext("/",e->{request.set(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
			var bytes="{\"ok\":true,\"result\":{\"message_id\":8,\"chat\":{\"id\":42}}}".getBytes(StandardCharsets.UTF_8);
			e.sendResponseHeaders(200,bytes.length);e.getResponseBody().write(bytes);e.close();});server.start();
		try {
			var keyboard=new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("Изменить слоты","slot_edit"))));
			var message=TelegramTransport.Message.withMarkup(42,null,"Слоты",false,json.valueToTree(keyboard.markup()));
			assertThat(message.keyboard()).isNull();assertThat(message.inlineKeyboard()).isEqualTo(keyboard);
			assertThat(client(URI.create("http://127.0.0.1:"+server.getAddress().getPort()+"/"),Duration.ofSeconds(2)).send(message).kind()).isEqualTo(TelegramTransport.Kind.SENT);
			var body=json.readTree(request.get());assertThat(body.path("reply_markup")).isEqualTo(json.valueToTree(keyboard.markup()));
			assertThat(body.has("parse_mode")).isFalse();assertThat(body.has("message_thread_id")).isFalse();assertThat(body.has("allow_paid_broadcast")).isFalse();
		}finally { server.stop(0); }
	}
	@Test void inlineKeyboardIsImmutableAndCallbackLimitCountsUtf8BytesNotCharacters() {
		var button=new TelegramTransport.InlineButton("Час","я".repeat(32)); // Exactly 64 bytes.
		var row=new java.util.ArrayList<>(java.util.List.of(button));var rows=new java.util.ArrayList<java.util.List<TelegramTransport.InlineButton>>();rows.add(row);
		var keyboard=new TelegramTransport.InlineKeyboard(rows);row.clear();rows.clear();assertThat(keyboard.rows()).containsExactly(java.util.List.of(button));
		assertThatThrownBy(()->keyboard.rows().getFirst().clear()).isInstanceOf(UnsupportedOperationException.class);
		assertThat(TelegramTransport.InlineKeyboard.parse(json.valueToTree(keyboard.markup()))).isEqualTo(keyboard);
		for(var callback:java.util.List.of(""," ","x".repeat(65),"я".repeat(33),"😀".repeat(17),"\uD800"))
			assertThatThrownBy(()->new TelegramTransport.InlineButton("Час",callback)).hasMessage("invalid_inline_keyboard");
		assertThatThrownBy(()->new TelegramTransport.InlineButton("x".repeat(129),"slot_edit")).hasMessage("invalid_inline_keyboard");
		for(var invalid:java.util.List.of(java.util.List.<java.util.List<TelegramTransport.InlineButton>>of(),java.util.List.of(java.util.List.<TelegramTransport.InlineButton>of()),java.util.Collections.nCopies(17,java.util.List.of(button)),java.util.List.of(java.util.Collections.nCopies(9,button))))
			assertThatThrownBy(()->new TelegramTransport.InlineKeyboard(invalid)).hasMessage("invalid_inline_keyboard");
	}
	@Test void inlineMarkupRejectsOtherActionsMixedKeyboardsAndNonPrivateTargets() {
		var keyboard=new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("Слоты","slot_edit"))));
		for(var extra:java.util.List.of("\"url\":\"https://example.com\"","\"pay\":true","\"web_app\":{}","\"login_url\":{}","\"switch_inline_query\":\"x\"")) {
			var markup=json.readTree("{\"inline_keyboard\":[[{\"text\":\"Слоты\",\"callback_data\":\"slot_edit\","+extra+"}]]}");
			assertThatThrownBy(()->TelegramTransport.Message.withMarkup(42,null,"text",false,markup)).hasMessage("invalid_inline_keyboard");
		}
		for(var markup:java.util.List.of("{\"inline_keyboard\":[],\"keyboard\":[]}","{\"inline_keyboard\":[[{\"text\":\"x\",\"callback_data\":1}]]}","{\"inline_keyboard\":[[{\"text\":\"x\"}]]}","{\"inline_keyboard\":[[]]}","{\"inline_keyboard\":[{}]}"))
			assertThatThrownBy(()->TelegramTransport.Message.withMarkup(42,null,"text",false,json.readTree(markup))).hasMessage("invalid_inline_keyboard");
		assertThatThrownBy(()->new TelegramTransport.Message(-100,null,"text",false,null,keyboard)).hasMessage("invalid_keyboard_target");
		assertThatThrownBy(()->new TelegramTransport.Message(42,1L,"text",false,null,keyboard)).hasMessage("invalid_keyboard_target");
		assertThatThrownBy(()->new TelegramTransport.Message(42,null,"text",false,new TelegramTransport.ReplyKeyboard(java.util.List.of(java.util.List.of("Меню"))),keyboard)).hasMessage("conflicting_keyboards");
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
					new TelegramTransport.Message(999,null,"test",false,null,new TelegramTransport.InlineKeyboard(java.util.List.of(java.util.List.of(new TelegramTransport.InlineButton("Слоты","slot_edit"))))),
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
