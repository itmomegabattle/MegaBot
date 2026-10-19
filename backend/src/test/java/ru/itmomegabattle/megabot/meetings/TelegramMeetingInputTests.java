package ru.itmomegabattle.megabot.meetings;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import org.junit.jupiter.api.Test;
import ru.itmomegabattle.megabot.common.ApiException;

class TelegramMeetingInputTests {
    private final Clock clock=Clock.fixed(Instant.parse("2026-12-31T22:30:00Z"),ZoneOffset.UTC);

    @Test void datesUseMoscowCalendarAndKeepCompleteExplicitYear() {
        assertThat(TelegramMeetingInput.date("СЕГОДНЯ",clock)).isEqualTo(LocalDate.of(2027,1,1));
        assertThat(TelegramMeetingInput.date(" завтра ",clock)).isEqualTo(LocalDate.of(2027,1,2));
        assertThat(TelegramMeetingInput.date("послезавтра",clock)).isEqualTo(LocalDate.of(2027,1,3));
        assertThat(TelegramMeetingInput.date("2/1",clock)).isEqualTo(LocalDate.of(2027,1,2));
        assertThat(TelegramMeetingInput.date("29-2-28",clock)).isEqualTo(LocalDate.of(2028,2,29));
        assertThat(TelegramMeetingInput.date("29.02.2400",clock)).isEqualTo(LocalDate.of(2400,2,29));
        for(var text:new String[]{"29.02.2027","31.04.2027","0.1.2027","1.13.2027","1.1.0000","1.1.20277","2027-01-01","1.1.2027 12:00","tomorrow",""})
            assertThatThrownBy(()->TelegramMeetingInput.date(text,clock)).as(text).isInstanceOf(ApiException.class);
    }

    @Test void timesAcceptLegacyChatFormsWithoutRestrictingMinuteOrHour() {
        for(var text:new String[]{"18:30","18.30","18 30"})assertThat(TelegramMeetingInput.time(text)).isEqualTo(LocalTime.of(18,30));
        assertThat(TelegramMeetingInput.time(" 0 ")).isEqualTo(LocalTime.MIDNIGHT);
        assertThat(TelegramMeetingInput.time("23:59")).isEqualTo(LocalTime.of(23,59));
        assertThat(TelegramMeetingInput.time("2:7")).isEqualTo(LocalTime.of(2,7));
        for(var text:new String[]{"24:00","23:60","-1","18:30:00","18  30","18:","18,30",""})
            assertThatThrownBy(()->TelegramMeetingInput.time(text)).as(text).isInstanceOf(ApiException.class);
    }
}
