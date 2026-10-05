package ru.itmomegabattle.megabot.notifications;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import ru.itmomegabattle.megabot.common.ApiException;

/** Plain-text transport only: preserve grapheme clusters and literal entity tokens, no HTML parser/renderer. */
final class BroadcastText {
	static final int MAX_LENGTH=40000;
	private static final Pattern UNIT=Pattern.compile("&(?:#[0-9]{1,10}|#x[0-9A-Fa-f]{1,8}|[A-Za-z][A-Za-z0-9]{0,63});|\\X");
	static List<String> split(String text) {
		if(text==null || text.isBlank() || text.length()>MAX_LENGTH)throw bad("broadcast_text_too_long");
		if(text.codePoints().anyMatch(c->c>=0xD800 && c<=0xDFFF))throw bad("broadcast_text_invalid_unicode");
		var parts=new ArrayList<String>();var chunk=new StringBuilder();var units=UNIT.matcher(text);
		while(units.find()) {
			var unit=units.group();
			if(unit.length()>4000)throw bad("broadcast_text_unit_too_long");
			if(chunk.length()+unit.length()>4000) { parts.add(chunk.toString());chunk.setLength(0); }
			chunk.append(unit);
		}
		if(!chunk.isEmpty())parts.add(chunk.toString());
		if(parts.size()>20 || parts.stream().anyMatch(String::isBlank))throw bad("broadcast_text_part_invalid");
		return List.copyOf(parts);
	}
	private static ApiException bad(String code) { return new ApiException(HttpStatus.BAD_REQUEST,code,"Текст слишком длинный или содержит неделимый блок; разделите его на отдельные рассылки"); }
}
