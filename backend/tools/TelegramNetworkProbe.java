import java.net.URI;
import java.net.ProxySelector;
import java.net.http.*;
import java.time.Duration;

/** Public endpoint only: never accepts a token or sends Telegram messages. */
class TelegramNetworkProbe {
    public static void main(String[] args) {
        var uri=URI.create("https://api.telegram.org");
        System.out.println("systemProxy="+System.getProperty("java.net.useSystemProxies","false")
                +", ipv4="+System.getProperty("java.net.preferIPv4Stack","false")
                +", selected="+ProxySelector.getDefault().select(uri));
        try(var client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()) {
            var response=client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).GET().build(),HttpResponse.BodyHandlers.discarding());
            System.out.println("HTTP="+response.statusCode());
        } catch(Exception e) { System.out.println("FAILED="+e.getClass().getSimpleName()); System.exit(1); }
    }
}
