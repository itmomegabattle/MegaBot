package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

final class TaskLogCsv {
	private static final DateTimeFormatter TIME=DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS")
			.withZone(ZoneId.of("Europe/Moscow"));
	private TaskLogCsv() {}
	static String render(List<Map<String,Object>> entries) {
		var csv=new StringBuilder("\uFEFF");
		line(csv,List.of("ID записи","ID задачи","Время (Москва)","Действие","Предыдущий статус","Статус",
				"Кто изменил","ID изменившего","Задача","Описание","ТЗ","Мероприятие","Факультет",
				"Приоритет","Дедлайн (Москва)","Завершил","ID завершившего","Затрачено, мин","Версия",
				"ID исполнителей","ID компетенций","Подсказки","Напоминания","Комментарии изменения",
				"ID автора задачи","Создана (Москва)","Завершена (Москва)","ID отменившего","Отменена (Москва)"));
		for(var entry:entries) {
			var d=(JsonNode)entry.get("details");
			line(csv,List.of(value(entry.get("id")),value(entry.get("taskId")),time(entry.get("occurredAt")),
					action(d.path("action").asText("")),status(value(entry.get("previousStatus"))),status(value(entry.get("status"))),
					value(entry.get("actorName")),value(entry.get("actorId")),field(d,"title"),field(d,"description"),field(d,"sow"),
					value(entry.get("eventName")),value(entry.get("facultyName")),priority(field(d,"priority")),time(field(d,"dueAt")),
					value(entry.get("completedByName")),field(d,"completedBy"),field(d,"timeSpentMinutes"),field(d,"version"),
					field(d,"assigneeIds"),field(d,"competencyIds"),field(d,"tips"),field(d,"reminders"),field(d,"comments"),
					field(d,"creatorId"),time(field(d,"createdAt")),time(field(d,"completedAt")),field(d,"cancelledBy"),time(field(d,"cancelledAt"))));
		}
		return csv.toString();
	}
	private static String field(JsonNode node,String key) {
		var value=node.path(key);
		return value.isMissingNode() || value.isNull()?"":value.isContainer()?value.toString():value.asText();
	}
	private static String time(Object value) {
		if(value==null || value.toString().isEmpty()) return "";
		try { return TIME.format(value instanceof Instant i?i:Instant.parse(value.toString())); }
		catch(java.time.DateTimeException error) { return value.toString(); }
	}
	private static String value(Object value) { return value==null?"":value.toString(); }
	private static void line(StringBuilder csv,List<String> cells) {
		csv.append(cells.stream().map(TaskLogCsv::cell).collect(java.util.stream.Collectors.joining(";"))).append("\r\n");
	}
	static String cell(String text) {
		// Quoting alone does not neutralize spreadsheet formulas. Inspect after invisible prefix characters too.
		int start=0;
		while(start<text.length() && (Character.isWhitespace(text.charAt(start)) || Character.isSpaceChar(text.charAt(start))
				|| Character.getType(text.charAt(start))==Character.FORMAT)) start++;
		if(start<text.length() && "=+-@".indexOf(text.charAt(start))>=0) text="'"+text;
		return "\""+text.replace("\"","\"\"")+"\"";
	}
	private static String status(String s) { return switch(s) {
		case "open"->"Свободна"; case "assigned"->"Назначена"; case "in_progress"->"В работе";
		case "waiting"->"Ожидает"; case "completed"->"Выполнена"; case "cancelled"->"Отменена"; default->s; }; }
	private static String action(String a) { return switch(a) {
		case "created"->"Создание"; case "updated"->"Правка"; case "claim"->"Взята в работу";
		case "release"->"Снятие назначения"; case "cancel"->"Отмена"; case "status"->"Смена статуса";
		case "comment"->"Комментарий"; default->a; }; }
	private static String priority(String p) { return switch(p) {
		case "normal"->"Обычный"; case "important"->"Важный"; case "critical"->"Критический"; default->p; }; }
}
