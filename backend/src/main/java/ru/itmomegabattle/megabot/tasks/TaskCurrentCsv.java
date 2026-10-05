package ru.itmomegabattle.megabot.tasks;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;

final class TaskCurrentCsv {
	private static final DateTimeFormatter TIME=DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS").withZone(ZoneId.of("Europe/Moscow"));
	private TaskCurrentCsv() {}
	static String render(List<Map<String,Object>> tasks) {
		var csv=new StringBuilder("\uFEFF");
		line(csv,List.of("ID задачи","Мероприятие","Блок","Статус","Название","Описание","ТЗ","Дедлайн (Москва)",
				"Создана (Москва)","Завершена (Москва)","Автор","Исполнители","Приоритет","Затрачено, мин","Подсказки","Факультет","Завершил","Версия"));
		for(var t:tasks) line(csv,List.of(value(t.get("id")),value(t.get("eventName")),value(t.get("competencyNames")),value(t.get("status")),
				value(t.get("title")),value(t.get("description")),value(t.get("sow")),value(t.get("dueAt")),value(t.get("createdAt")),
				value(t.get("completedAt")),value(t.get("creatorName")),value(t.get("executorNames")),value(t.get("priority")),
				value(t.get("timeSpentMinutes")),value(t.get("tips")),value(t.get("facultyName")),value(t.get("completedByName")),value(t.get("version"))));
		return csv.toString();
	}
	private static String value(Object v) {
		if(v==null) return "";
		if(v instanceof Instant i) return TIME.format(i);
		if(v instanceof List<?> l) return l.stream().map(TaskCurrentCsv::value).collect(java.util.stream.Collectors.joining("\n"));
		return v.toString();
	}
	private static void line(StringBuilder csv,List<String> cells) {
		csv.append(cells.stream().map(TaskLogCsv::cell).collect(java.util.stream.Collectors.joining(";"))).append("\r\n");
	}
}
