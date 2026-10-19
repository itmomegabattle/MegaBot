package ru.itmomegabattle.megabot.availability;

import static org.assertj.core.api.Assertions.*;
import java.time.*;
import java.time.temporal.TemporalAdjusters;
import java.util.List;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.junit.jupiter.Testcontainers;
import ru.itmomegabattle.megabot.TestcontainersConfiguration;
import ru.itmomegabattle.megabot.auth.AuthenticatedUser;
import ru.itmomegabattle.megabot.common.ApiException;
import ru.itmomegabattle.megabot.team.*;

@SpringBootTest
@Import(TestcontainersConfiguration.class)
@ActiveProfiles("test")
@Testcontainers(disabledWithoutDocker=true)
class TelegramSlotDraftIntegrationTests {
    @Autowired TelegramSlotDraftService drafts;
    @Autowired AvailabilityService availability;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    UserEntity user;LocalDate week;
    @BeforeEach void prepare() {
        jdbc.execute("truncate users,app_settings,availability_week_metadata,audit_events cascade");
        user=users.saveAndFlush(new UserEntity(901L,"slot_owner","Owner","organizer"));
        users.saveAndFlush(new UserEntity(902L,"other_owner","Other","organizer"));
        users.saveAndFlush(new UserEntity(903L,"faculty_owner","Faculty","faculty_helper"));
        week=LocalDate.now(ZoneId.of("Europe/Moscow")).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
    }
    AvailabilityController.SaveWeekRequest request(long version) {
        return new AvailabilityController.SaveWeekRequest(false,List.of(new AvailabilityController.DayMutation(week,"available",List.of(1020))),version);
    }
    AuthenticatedUser actor() { return new AuthenticatedUser(user.getId(),user.getUsername(),user.getRealName(),"organizer"); }
    @Test void cancelDayRestoresPendingEntryValueAndKeepsNeighboursAndDeadline() {
        var first=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,first.id(),0,request(0));
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class);
        var entered=drafts.beginDay("123",901,edited.id(),edited.revision(),week);
        var changed=drafts.replace("123",901,entered.id(),entered.revision(),new AvailabilityController.SaveWeekRequest(false,List.of(
                new AvailabilityController.DayMutation(week,"available",List.of(1080)),
                new AvailabilityController.DayMutation(week.plusDays(1),"unavailable",List.of())),0));
        var reopened=drafts.beginDay("123",901,changed.id(),changed.revision(),week);
        var restored=drafts.cancelDay("123",901,reopened.id(),reopened.revision(),week);
        assertThat(restored.request().days()).anySatisfy(d->{assertThat(d.date()).isEqualTo(week);assertThat(d.startMinutes()).containsExactly(1020);})
                .anySatisfy(d->{assertThat(d.date()).isEqualTo(week.plusDays(1));assertThat(d.status()).isEqualTo("unavailable");});
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class)).isEqualTo(deadline);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThatThrownBy(()->drafts.cancelDay("123",901,restored.id(),restored.revision(),week)).isInstanceOf(ApiException.class);
    }
    @Test void dayBaselineDistinguishesAbsentUnansweredAndUnavailable() {
        for(var status:List.of("absent","unanswered","unavailable")) {
            var opened=drafts.open("123",901,week);
            var original=new AvailabilityController.SaveWeekRequest(false,status.equals("absent")?List.of():List.of(
                    new AvailabilityController.DayMutation(week,status,List.of())),0);
            var initial=drafts.replace("123",901,opened.id(),0,original);
            var entered=drafts.beginDay("123",901,initial.id(),initial.revision(),week);
            var changed=drafts.replace("123",901,entered.id(),entered.revision(),request(0));
            assertThat(drafts.cancelDay("123",901,changed.id(),changed.revision(),week).request()).isEqualTo(original);
        }
    }
    @Test void saveOtherDayKeepsBaselineButSaveSelectedDayAndWeekClearIt() {
        var opened=drafts.open("123",901,week);
        var entered=drafts.beginDay("123",901,opened.id(),0,week);
        var changed=drafts.replace("123",901,entered.id(),entered.revision(),new AvailabilityController.SaveWeekRequest(false,List.of(
                new AvailabilityController.DayMutation(week,"available",List.of(1020)),
                new AvailabilityController.DayMutation(week.plusDays(1),"unavailable",List.of())),0));
        var savedOther=drafts.saveDay("123",901,changed.id(),changed.revision(),week.plusDays(1));
        var cancelled=drafts.cancelDay("123",901,savedOther.id(),savedOther.revision(),week);
        assertThat(cancelled.request().days()).noneMatch(d->d.date().equals(week));
        assertThat(availability.get(actor(),null).weeks().getFirst().days()).anySatisfy(d->{
            assertThat(d.date()).isEqualTo(week.plusDays(1));assertThat(d.status()).isEqualTo("unavailable");});
        var next=drafts.beginDay("123",901,cancelled.id(),cancelled.revision(),week.plusDays(1));
        var saved=drafts.saveDay("123",901,next.id(),next.revision(),week.plusDays(1));
        assertThatThrownBy(()->drafts.cancelDay("123",901,saved.id(),saved.revision(),week.plusDays(1))).isInstanceOf(ApiException.class);
        next=drafts.beginDay("123",901,saved.id(),saved.revision(),week);
        drafts.save("123",901,next.id(),next.revision());
        var finalDraft=drafts.get("123",901,next.id());
        assertThatThrownBy(()->drafts.cancelDay("123",901,finalDraft.id(),finalDraft.revision(),week)).isInstanceOf(ApiException.class);
    }
    @Test void leavingDayForWeekOrOutCannotReuseBaseline() {
        var opened=drafts.open("123",901,week);
        var entered=drafts.beginDay("123",901,opened.id(),0,week);
        var other=drafts.selectWeek("123",901,entered.id(),entered.revision(),week.plusWeeks(1));
        assertThatThrownBy(()->drafts.cancelDay("123",901,other.id(),other.revision(),week.plusWeeks(1))).isInstanceOf(ApiException.class);
        var returned=drafts.selectWeek("123",901,other.id(),other.revision(),week);
        assertThatThrownBy(()->drafts.cancelDay("123",901,returned.id(),returned.revision(),week)).isInstanceOf(ApiException.class);
        var again=drafts.beginDay("123",901,returned.id(),returned.revision(),week);
        var out=drafts.replace("123",901,again.id(),again.revision(),new AvailabilityController.SaveWeekRequest(true,List.of(),0));
        assertThatThrownBy(()->drafts.beginDay("123",901,out.id(),out.revision(),week)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
    }
    @Test void failedBaselineAdvanceAndSaveRollBackDaySnapshotAndDomainWrites() {
        var opened=drafts.open("123",901,week);
        jdbc.execute("alter table telegram_slot_drafts add constraint baseline_failure check(revision=0)");
        try { assertThatThrownBy(()->drafts.beginDay("123",901,opened.id(),0,week)).isInstanceOf(RuntimeException.class); }
        finally { jdbc.execute("alter table telegram_slot_drafts drop constraint baseline_failure"); }
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        var entered=drafts.beginDay("123",901,opened.id(),0,week);
        var changed=drafts.replace("123",901,entered.id(),entered.revision(),request(0));
        var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        jdbc.execute("alter table telegram_slot_drafts add constraint baseline_failure check(revision<=2)");
        try {
            assertThatThrownBy(()->drafts.cancelDay("123",901,changed.id(),changed.revision(),week)).isInstanceOf(RuntimeException.class);
            assertThatThrownBy(()->drafts.saveDay("123",901,changed.id(),changed.revision(),week)).isInstanceOf(RuntimeException.class);
        } finally { jdbc.execute("alter table telegram_slot_drafts drop constraint baseline_failure"); }
        assertThat(drafts.get("123",901,changed.id())).isEqualTo(changed);
        assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(drafts.cancelDay("123",901,changed.id(),changed.revision(),week).request().days()).isEmpty();
    }
    @Test @Timeout(60) void concurrentDayCancelHasOneWinnerAndCannotReplay() throws Exception {
        var opened=drafts.open("123",901,week);var entered=drafts.beginDay("123",901,opened.id(),0,week);
        var changed=drafts.replace("123",901,entered.id(),entered.revision(),request(0));var gate=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> cancel=()->{gate.await();try {drafts.cancelDay("123",901,changed.id(),changed.revision(),week);return true;}
                catch(ApiException e){return false;}};
            var a=pool.submit(cancel);var b=pool.submit(cancel);gate.countDown();
            assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(drafts.get("123",901,changed.id()).revision()).isEqualTo(3);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
    }
    @Test void invalidDayOwnerRevisionAndExpiryCannotChangeBaseline() {
        var opened=drafts.open("123",901,week);
        for(var date:java.util.Arrays.asList(null,week.minusDays(1),week.plusDays(6),week.plusWeeks(1)))
            assertThatThrownBy(()->drafts.beginDay("123",901,opened.id(),0,date)).isInstanceOf(ApiException.class);
        var entered=drafts.beginDay("123",901,opened.id(),0,week);
        var baseline=jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class);
        assertThatThrownBy(()->drafts.cancelDay("456",901,entered.id(),entered.revision(),week)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.cancelDay("123",902,entered.id(),entered.revision(),week)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.cancelDay("123",901,entered.id(),0,week)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.cancelDay("123",901,entered.id(),entered.revision(),week.plusDays(1))).isInstanceOf(ApiException.class);
        jdbc.update("update telegram_slot_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second'");
        assertThatThrownBy(()->drafts.cancelDay("123",901,entered.id(),entered.revision(),week)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select day_baseline::text from telegram_slot_drafts",String.class)).isEqualTo(baseline);
    }
    @Test void expiryDuringDayEntryRollsBackBaselineAndDeadline() {
        var opened=drafts.open("123",901,week);
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class);
        jdbc.execute("""
                create function expire_baseline_fixture() returns trigger language plpgsql as $$
                begin
                    if OLD.day_baseline is null and NEW.day_baseline is not null then
                        NEW.created_at=clock_timestamp()-interval '20 minutes';
                        NEW.expires_at=clock_timestamp()-interval '1 second';
                    end if;
                    return NEW;
                end $$
                """);
        jdbc.execute("create trigger expire_baseline before update on telegram_slot_drafts for each row execute function expire_baseline_fixture()");
        try {assertThatThrownBy(()->drafts.beginDay("123",901,opened.id(),0,week)).isInstanceOf(ApiException.class);}
        finally {
            jdbc.execute("drop trigger expire_baseline on telegram_slot_drafts");
            jdbc.execute("drop function expire_baseline_fixture()");
        }
        assertThat(drafts.get("123",901,opened.id())).isEqualTo(opened);
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class)).isEqualTo(deadline);
        assertThat(jdbc.queryForObject("select day_baseline is null from telegram_slot_drafts",Boolean.class)).isTrue();
        assertThat(drafts.beginDay("123",901,opened.id(),0,week).revision()).isEqualTo(1);
    }
    @Test void weekNavigationAndSavePreserveOtherPendingWeeksAndDeadline() {
        var draft=drafts.open("123",901,week);
        var deadline=jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class);
        draft=drafts.replace("123",901,draft.id(),0,request(0));
        draft=drafts.selectWeek("123",901,draft.id(),draft.revision(),week.plusWeeks(1));
        draft=drafts.replace("123",901,draft.id(),draft.revision(),new AvailabilityController.SaveWeekRequest(false,List.of(
                new AvailabilityController.DayMutation(week.plusWeeks(1),"unavailable",List.of())),0));
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        var returned=drafts.selectWeek("123",901,draft.id(),draft.revision(),week);
        assertThat(returned.request()).isEqualTo(request(0));
        drafts.save("123",901,returned.id(),returned.revision());
        var afterSave=drafts.get("123",901,returned.id());
        assertThat(afterSave.request().expectedVersion()).isEqualTo(1);
        var other=drafts.selectWeek("123",901,afterSave.id(),afterSave.revision(),week.plusWeeks(1));
        assertThat(other.request().days().getFirst().status()).isEqualTo("unavailable");
        assertThat(other.request().expectedVersion()).isZero();
        drafts.saveDay("123",901,other.id(),other.revision(),week.plusWeeks(1));
        var afterDay=drafts.get("123",901,other.id());
        assertThat(drafts.selectWeek("123",901,afterDay.id(),afterDay.revision(),week).request().expectedVersion()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select expires_at::text from telegram_slot_drafts",String.class)).isEqualTo(deadline);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isEqualTo(2);
    }
    @Test void staleParkedWeekCannotRebaseAndInvalidNavigationKeepsEveryEdit() {
        var first=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,first.id(),0,request(0));
        var other=drafts.selectWeek("123",901,edited.id(),edited.revision(),week.plusWeeks(1));
        availability.saveWeek(actor(),null,week,request(0));
        for(var target:java.util.Arrays.asList(null,week,week.plusDays(1),week.plusWeeks(9)))
            assertThatThrownBy(()->drafts.selectWeek("123",901,other.id(),other.revision(),target)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.selectWeek("456",901,other.id(),other.revision(),week.plusWeeks(2))).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.selectWeek("123",902,other.id(),other.revision(),week.plusWeeks(2))).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.selectWeek("123",901,other.id(),edited.revision(),week.plusWeeks(2))).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,other.id())).isEqualTo(other);
        assertThat(jdbc.queryForObject("select pending_weeks->?->>'expectedVersion' from telegram_slot_drafts",String.class,week.toString())).isEqualTo("0");
    }
    @Test void failedNavigationAndWeekSaveRollBackPendingStateWeekAndAudit() {
        var first=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,first.id(),0,request(0));
        jdbc.execute("alter table telegram_slot_drafts add constraint navigation_failure check(revision<=1)");
        try {
            assertThatThrownBy(()->drafts.selectWeek("123",901,edited.id(),1,week.plusWeeks(1))).isInstanceOf(RuntimeException.class);
            assertThatThrownBy(()->drafts.save("123",901,edited.id(),1)).isInstanceOf(RuntimeException.class);
        } finally { jdbc.execute("alter table telegram_slot_drafts drop constraint navigation_failure"); }
        assertThat(drafts.get("123",901,edited.id())).isEqualTo(edited);
        assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo("{}");
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(drafts.selectWeek("123",901,edited.id(),1,week.plusWeeks(1)).week()).isEqualTo(week.plusWeeks(1));
    }
    @Test @Timeout(60) void concurrentWeekNavigationHasOneWinner() throws Exception {
        var draft=drafts.open("123",901,week);var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> navigate=()->{start.await();try {drafts.selectWeek("123",901,draft.id(),0,week.plusWeeks(1));return true;}
                catch(ApiException e){return false;}};
            var a=pool.submit(navigate);var b=pool.submit(navigate);start.countDown();
            assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
    }
    @Test void allFiveWeeksRetainOutAndTriStateDraftsAcrossServiceReads() {
        jdbc.update("insert into app_settings(setting_key,setting_value,version) values ('availability',cast(? as jsonb),1)",
                "{\"weekCount\":5,\"activeDays\":[0,1,2,3,4],\"firstHour\":17,\"lastHour\":23}");
        var draft=drafts.open("123",901,week);
        for(int index=0;index<5;index++) {
            var target=week.plusWeeks(index);
            draft=drafts.selectWeek("123",901,draft.id(),draft.revision(),target);
            draft=drafts.replace("123",901,draft.id(),draft.revision(),new AvailabilityController.SaveWeekRequest(index==4,
                    index==4?List.of():List.of(new AvailabilityController.DayMutation(target,index==0?"available":index==1?"unavailable":"unanswered",
                            index==0?List.of(1020):List.of())),0));
        }
        for(int index=0;index<5;index++) {
            draft=drafts.get("123",901,draft.id());
            draft=drafts.selectWeek("123",901,draft.id(),draft.revision(),week.plusWeeks(index));
            assertThat(draft.request().outOfWeek()).isEqualTo(index==4);
            if(index<4)assertThat(draft.request().days().getFirst().status()).isEqualTo(index==0?"available":index==1?"unavailable":"unanswered");
        }
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
    }
    @Test void navigationRevalidatesParkedHoursWithoutDiscardingThem() {
        var draft=drafts.open("123",901,week);
        drafts.replace("123",901,draft.id(),0,request(0));
        var other=drafts.selectWeek("123",901,draft.id(),1,week.plusWeeks(1));
        jdbc.update("insert into app_settings(setting_key,setting_value,version) values ('availability',cast(? as jsonb),1)",
                "{\"weekCount\":4,\"activeDays\":[0,1,2,3,4],\"firstHour\":18,\"lastHour\":23}");
        assertThatThrownBy(()->drafts.selectWeek("123",901,other.id(),other.revision(),week)).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,other.id())).isEqualTo(other);
        assertThat(jdbc.queryForObject("select pending_weeks->?->'days'->0->'startMinutes'->>0 from telegram_slot_drafts",String.class,week.toString())).isEqualTo("1020");
    }
    @Test void expiryDuringNavigationRollsBackSelectedWeekAndPendingEdits() {
        var first=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,first.id(),0,request(0));
        jdbc.execute("""
                create function expire_navigation_fixture() returns trigger language plpgsql as $$
                begin
                    if NEW.week_start<>OLD.week_start then
                        NEW.created_at=clock_timestamp()-interval '20 minutes';
                        NEW.expires_at=clock_timestamp()-interval '1 second';
                    end if;
                    return NEW;
                end $$
                """);
        jdbc.execute("create trigger expire_navigation before update on telegram_slot_drafts for each row execute function expire_navigation_fixture()");
        try {assertThatThrownBy(()->drafts.selectWeek("123",901,edited.id(),1,week.plusWeeks(1))).isInstanceOf(ApiException.class);}
        finally {
            jdbc.execute("drop trigger expire_navigation on telegram_slot_drafts");
            jdbc.execute("drop function expire_navigation_fixture()");
        }
        assertThat(drafts.get("123",901,edited.id())).isEqualTo(edited);
        assertThat(jdbc.queryForObject("select pending_weeks::text from telegram_slot_drafts",String.class)).isEqualTo("{}");
        assertThat(drafts.selectWeek("123",901,edited.id(),1,week.plusWeeks(1)).revision()).isEqualTo(2);
    }
    @Test void persistedEditsDoNotChangeWeekUntilAtomicSave() {
        var draft=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,draft.id(),0,request(0));
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(drafts.get("123",901,draft.id())).isEqualTo(edited);
        var saved=drafts.save("123",901,draft.id(),1);
        assertThat(saved.version()).isEqualTo(1);
        assertThat(saved.days().getFirst().startMinutes()).containsExactly(1020);
        assertThat(jdbc.queryForObject("select status from telegram_slot_drafts",String.class)).isEqualTo("open");
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(2);
        assertThatThrownBy(()->drafts.save("123",901,draft.id(),1)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isEqualTo(1);
    }
    @Test void cancellationAndReplacementDoNotWriteAvailability() {
        var first=drafts.open("123",901,week);
        var second=drafts.open("123",901,week.plusWeeks(1));
        assertThatThrownBy(()->drafts.get("123",901,first.id())).isInstanceOf(ApiException.class);
        drafts.cancel("123",901,second.id(),0);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from telegram_slot_drafts where status='cancelled'",Integer.class)).isEqualTo(2);
    }
    @Test void savingDayPreservesSavedNeighboursAndOtherPendingEdits() {
        availability.saveWeek(actor(),null,week,new AvailabilityController.SaveWeekRequest(false,List.of(
                new AvailabilityController.DayMutation(week.plusDays(1),"available",List.of(1080))),0));
        var draft=drafts.open("123",901,week);
        var edited=drafts.replace("123",901,draft.id(),0,new AvailabilityController.SaveWeekRequest(false,List.of(
                new AvailabilityController.DayMutation(week,"available",List.of(1020)),
                new AvailabilityController.DayMutation(week.plusDays(1),"unavailable",List.of())),1));
        var continued=drafts.saveDay("123",901,draft.id(),edited.revision(),week);
        var saved=availability.get(actor(),null).weeks().getFirst();
        assertThat(saved.version()).isEqualTo(2);
        assertThat(saved.days()).anySatisfy(d->{assertThat(d.date()).isEqualTo(week);assertThat(d.startMinutes()).containsExactly(1020);})
                .anySatisfy(d->{assertThat(d.date()).isEqualTo(week.plusDays(1));assertThat(d.startMinutes()).containsExactly(1080);});
        assertThat(continued.request().expectedVersion()).isEqualTo(2);
        assertThat(continued.request().days()).anySatisfy(d->{assertThat(d.date()).isEqualTo(week.plusDays(1));assertThat(d.status()).isEqualTo("unavailable");});
        assertThat(drafts.get("123",901,draft.id())).isEqualTo(continued);
        assertThat(jdbc.queryForObject("select base_version from telegram_slot_drafts",Long.class)).isEqualTo(2);
        assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),edited.revision(),week)).isInstanceOf(ApiException.class);
        var finalWeek=drafts.save("123",901,draft.id(),continued.revision());
        assertThat(finalWeek.version()).isEqualTo(3);
        assertThat(finalWeek.days()).anySatisfy(d->{assertThat(d.date()).isEqualTo(week.plusDays(1));assertThat(d.status()).isEqualTo("unavailable");});
    }
    @Test void savingUnansweredDayClearsOnlyThatDayAndStaleWeekCannotBeRebased() {
        availability.saveWeek(actor(),null,week,request(0));
        var draft=drafts.open("123",901,week);
        drafts.replace("123",901,draft.id(),0,new AvailabilityController.SaveWeekRequest(false,List.of(),1));
        var continued=drafts.saveDay("123",901,draft.id(),1,week);
        assertThat(availability.get(actor(),null).weeks().getFirst().days()).noneSatisfy(d->assertThat(d.status()).isEqualTo("available"));
        availability.saveWeek(actor(),null,week,request(2));
        assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),continued.revision(),week)).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,draft.id())).isEqualTo(continued);
        assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(3);
    }
    @Test void invalidDayOrOutWeekCannotWriteOrAdvanceDraft() {
        var draft=drafts.open("123",901,week);
        for(var date:java.util.Arrays.asList(null,week.minusDays(1),week.plusWeeks(1),week.plusDays(6)))
            assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),0,date)).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,draft.id())).isEqualTo(draft);
        var out=drafts.replace("123",901,draft.id(),0,new AvailabilityController.SaveWeekRequest(true,List.of(),0));
        assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),out.revision(),week)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
    }
    @Test void failedDraftAdvanceRollsBackSavedDayAndAuditThenAllowsRetry() {
        var draft=drafts.open("123",901,week);drafts.replace("123",901,draft.id(),0,request(0));
        jdbc.execute("alter table telegram_slot_drafts add constraint day_advance_failure check(revision<=1)");
        try { assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),1,week)).isInstanceOf(RuntimeException.class); }
        finally { jdbc.execute("alter table telegram_slot_drafts drop constraint day_advance_failure"); }
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        assertThat(drafts.saveDay("123",901,draft.id(),1,week).request().expectedVersion()).isEqualTo(1);
    }
    @Test @Timeout(60) void concurrentDaySavesHaveOneWinnerAndOneAudit() throws Exception {
        var draft=drafts.open("123",901,week);drafts.replace("123",901,draft.id(),0,request(0));
        var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> save=()->{start.await();try {drafts.saveDay("123",901,draft.id(),1,week);return true;}
                catch(ApiException e){return false;}};
            var a=pool.submit(save);var b=pool.submit(save);start.countDown();
            assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isEqualTo(1);
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(2);
    }
    @Test void expiryDuringDomainWriteRollsBackDayAuditAndDraft() {
        var draft=drafts.open("123",901,week);drafts.replace("123",901,draft.id(),0,request(0));
        jdbc.execute("""
                create function expire_day_draft_fixture() returns trigger language plpgsql as $$
                begin
                    update telegram_slot_drafts set created_at=clock_timestamp()-interval '20 minutes',
                        expires_at=clock_timestamp()-interval '1 second';
                    return NEW;
                end $$
                """);
        jdbc.execute("create trigger expire_day_draft before insert on audit_events for each row execute function expire_day_draft_fixture()");
        try { assertThatThrownBy(()->drafts.saveDay("123",901,draft.id(),1,week)).isInstanceOf(ApiException.class); }
        finally {
            jdbc.execute("drop trigger expire_day_draft on audit_events");
            jdbc.execute("drop function expire_day_draft_fixture()");
        }
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        assertThat(drafts.saveDay("123",901,draft.id(),1,week).request().expectedVersion()).isEqualTo(1);
    }
    @Test void botChatRoleProfileAndExpiryAreCheckedOnEveryAccess() {
        var draft=drafts.open("123",901,week);
        assertThatThrownBy(()->drafts.get("456",901,draft.id())).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.get("123",902,draft.id())).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.open("123",903,week)).isInstanceOf(ApiException.class);
        jdbc.update("update users set version=version+1 where id=?",user.getId());
        assertThatThrownBy(()->drafts.get("123",901,draft.id())).isInstanceOf(ApiException.class);
        var fresh=drafts.open("123",901,week);
        jdbc.update("update telegram_slot_drafts set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second' where id=?",fresh.id());
        assertThatThrownBy(()->drafts.save("123",901,fresh.id(),0)).isInstanceOf(ApiException.class);
        jdbc.update("update users set telegram_id=904 where id=?",user.getId());
        assertThatThrownBy(()->drafts.get("123",901,fresh.id())).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.get("123",904,fresh.id())).isInstanceOf(ApiException.class);
    }
    @Test void staleRevisionAndDomainVersionCannotOverwriteNewData() {
        var draft=drafts.open("123",901,week);
        drafts.replace("123",901,draft.id(),0,request(0));
        assertThatThrownBy(()->drafts.replace("123",901,draft.id(),0,request(0))).isInstanceOf(ApiException.class);
        availability.saveWeek(actor(),null,week,request(0));
        assertThatThrownBy(()->drafts.save("123",901,draft.id(),1)).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select version from availability_weeks",Long.class)).isEqualTo(1);
    }
    @Test void failedSaveRollsBackWeekAuditAndDraftCompletion() {
        var draft=drafts.open("123",901,week);drafts.replace("123",901,draft.id(),0,request(0));
        jdbc.execute("alter table availability_slots add constraint draft_fixture_failure check(start_minute<>1020)");
        try { assertThatThrownBy(()->drafts.save("123",901,draft.id(),1)).isInstanceOf(RuntimeException.class); }
        finally { jdbc.execute("alter table availability_slots drop constraint draft_fixture_failure"); }
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_events",Integer.class)).isZero();
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        assertThat(drafts.save("123",901,draft.id(),1).version()).isEqualTo(1);
    }
    @Test @Timeout(60) void concurrentEditsHaveOneRevisionWinner() throws Exception {
        var draft=drafts.open("123",901,week);var start=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Boolean> edit=()->{start.await();try { drafts.replace("123",901,draft.id(),0,request(0));return true; }
                catch(ApiException e) { return false; }};
            var a=pool.submit(edit);var b=pool.submit(edit);start.countDown();
            assertThat(List.of(a.get(15,TimeUnit.SECONDS),b.get(15,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
    }
    @Test void invalidDraftChangesUseSharedValidationWithoutLosingPreviousPayload() {
        var draft=drafts.open("123",901,week);
        var invalid=new AvailabilityController.SaveWeekRequest(false,List.of(new AvailabilityController.DayMutation(week,"available",java.util.Arrays.asList(1020,null))),0);
        assertThatThrownBy(()->drafts.replace("123",901,draft.id(),0,invalid)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->drafts.replace("123",901,draft.id(),0,request(1))).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,draft.id())).isEqualTo(draft);
    }
    @Test void roleOrActiveChangesBlockExistingDraftWithoutWritingWeek() {
        var draft=drafts.open("123",901,week);
        jdbc.update("update users set role='faculty_helper' where id=?",user.getId());
        assertThatThrownBy(()->drafts.save("123",901,draft.id(),0)).isInstanceOf(ApiException.class);
        jdbc.update("update users set role='organizer',active=false,deactivated_at=clock_timestamp() where id=?",user.getId());
        assertThatThrownBy(()->drafts.cancel("123",901,draft.id(),0)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
    }
    @Test void changedSettingsAreRevalidatedAtSaveAndInvalidOpenKeepsPreviousDraft() {
        var draft=drafts.open("123",901,week);drafts.replace("123",901,draft.id(),0,request(0));
        assertThatThrownBy(()->drafts.open("123",901,week.plusWeeks(9))).isInstanceOf(ApiException.class);
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
        jdbc.update("insert into app_settings(setting_key,setting_value,version) values ('availability',cast(? as jsonb),1)",
                "{\"weekCount\":4,\"activeDays\":[0,1,2,3,4],\"firstHour\":18,\"lastHour\":23}");
        assertThatThrownBy(()->drafts.save("123",901,draft.id(),1)).isInstanceOf(ApiException.class);
        assertThat(jdbc.queryForObject("select count(*) from availability_weeks",Integer.class)).isZero();
        assertThat(drafts.get("123",901,draft.id()).revision()).isEqualTo(1);
    }
    @Test @Timeout(60) void concurrentOpenLeavesOneCurrentDraftAndOtherBotIsIndependent() throws Exception {
        var gate=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<String> open=()->{gate.await();return drafts.open("123",901,week).id();};
            var a=pool.submit(open);var b=pool.submit(open);gate.countDown();
            assertThat(a.get(15,TimeUnit.SECONDS)).isNotEqualTo(b.get(15,TimeUnit.SECONDS));
        }
        assertThat(jdbc.queryForObject("select count(*) from telegram_slot_drafts where status='open'",Integer.class)).isEqualTo(1);
        drafts.open("456",901,week);
        assertThat(jdbc.queryForObject("select count(*) from telegram_slot_drafts where status='open'",Integer.class)).isEqualTo(2);
    }
}
