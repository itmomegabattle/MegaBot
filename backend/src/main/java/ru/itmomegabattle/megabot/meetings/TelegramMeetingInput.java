package ru.itmomegabattle.megabot.meetings;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import ru.itmomegabattle.megabot.common.ApiException;

final class TelegramMeetingInput {
    private static final Pattern DATE=Pattern.compile("([0-9]{1,2})[./-]([0-9]{1,2})(?:[./-]([0-9]{2}|[0-9]{4}))?");
    private static final Pattern TIME=Pattern.compile("([0-9]{1,2})(?:[:.\\s]([0-9]{1,2}))?");
    private TelegramMeetingInput() {}

    static LocalDate date(String text,Clock clock) {
        var input=text==null?"":text.strip().toLowerCase(Locale.ROOT);
        var today=LocalDate.now(clock.withZone(MeetingRules.PROJECT_ZONE));
        var relative=switch(input) { case "сегодня"->0; case "завтра"->1; case "послезавтра"->2; default->-1; };
        if(relative>=0)return today.plusDays(relative);
        var match=DATE.matcher(input);
        if(match.matches()) {
            var year=match.group(3)==null?today.getYear():Integer.parseInt(match.group(3));
            // Explicit legacy chat shorthand is 20xx; persistence always keeps the complete year.
            if(match.group(3)!=null && match.group(3).length()==2)year+=2000;
            try {
                if(year>0)return LocalDate.of(year,Integer.parseInt(match.group(2)),Integer.parseInt(match.group(1)));
            } catch(DateTimeException invalid) { /* Report the same bounded input error. */ }
        }
        throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_meeting_date","Укажите дату: например, 14.08.2026, 14.08 или «завтра».");
    }

    static LocalTime time(String text) {
        var match=TIME.matcher(text==null?"":text.strip());
        if(match.matches()) {
            try { return LocalTime.of(Integer.parseInt(match.group(1)),match.group(2)==null?0:Integer.parseInt(match.group(2))); }
            catch(DateTimeException invalid) { /* Report the same bounded input error. */ }
        }
        throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_meeting_time","Укажите время: например, 18:00, 18.30 или 18.");
    }
}
