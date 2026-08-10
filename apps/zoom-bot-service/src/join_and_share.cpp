// Zoom Bot Service — production build-out of the validated design in
// spikes/zoom-presentation-bot/zoom-sdk-integration/join_and_share.cpp
// (docs/07-zoom-bot.md's "Phase 0 spike status": the exact join+StartAppShare
// flow below already ran against a real, live Zoom meeting and was visually
// confirmed working). This file keeps that proven logic unchanged and only
// renames Spike* -> Bot* for a production service's naming — see the spike's
// own file for the header-by-header API research that justified each call.
//
// What's actually different from the spike, all outside this file: the
// Chromium window it shares now loads a real /present/[sessionId] route
// (apps/zoom-bot-service/start.sh) instead of a static test page, and the
// window handle is found by "the one window on this X11 display" rather
// than matching a fixed page title — see start.sh for why.
//
// v1 gap, stated rather than silently absent: no reconnect-on-drop logic in
// this process. If the meeting connection drops (onMeetingStatusChanged
// reporting anything other than staying MEETING_STATUS_INMEETING), this
// process does not attempt to rejoin — it relies on the container's own
// restart policy (docker-compose.yml's `restart: unless-stopped`) to do a
// full fresh restart (new Xvfb, new Chromium, new join) instead. Crude but
// functional for v1; a real in-process reconnect is real future work.

#include <QCoreApplication>
#include <QTimer>
#include <QDebug>

#include <openssl/hmac.h>
#include <openssl/evp.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <chrono>

#include "zoom_sdk.h"
#include "auth_service_interface.h"
#include "meeting_service_interface.h"
#include "meeting_service_components/meeting_sharing_interface.h"

using namespace ZOOMSDK;

// ---------------------------------------------------------------------
// Minimal base64url encoding — the JWT header/payload/signature all need
// base64url (no padding), not standard base64.
// ---------------------------------------------------------------------
static std::string base64UrlEncode(const unsigned char* data, size_t len) {
    static const char* table =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    int val = 0, valb = -6;
    for (size_t i = 0; i < len; i++) {
        val = (val << 8) + data[i];
        valb += 8;
        while (valb >= 0) {
            out.push_back(table[(val >> valb) & 0x3F]);
            valb -= 6;
        }
    }
    if (valb > -6) out.push_back(table[((val << 8) >> (valb + 8)) & 0x3F]);
    for (auto& c : out) {
        if (c == '+') c = '-';
        else if (c == '/') c = '_';
    }
    return out;
}

static std::string base64UrlEncode(const std::string& s) {
    return base64UrlEncode(reinterpret_cast<const unsigned char*>(s.data()), s.size());
}

// Builds the SDK-auth JWT per tagAuthContext's doc comment in
// auth_service_interface.h: header {"alg":"HS256","typ":"JWT"}, payload
// {appKey, iat, exp, tokenExp}, HMAC-SHA256 signed with the SDK secret.
static std::string buildSdkAuthJwt(const std::string& sdkKey, const std::string& sdkSecret) {
    const auto now = std::chrono::system_clock::now();
    const long iat = std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
    const long exp = iat + 60 * 60 * 2;      // 2 hour auth-token validity
    const long tokenExp = exp;

    const std::string header = R"({"alg":"HS256","typ":"JWT"})";
    std::string payload = R"({"appKey":")" + sdkKey +
        R"(","iat":)" + std::to_string(iat) +
        R"(,"exp":)" + std::to_string(exp) +
        R"(,"tokenExp":)" + std::to_string(tokenExp) + "}";

    const std::string signingInput = base64UrlEncode(header) + "." + base64UrlEncode(payload);

    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLen = 0;
    HMAC(EVP_sha256(),
         sdkSecret.data(), static_cast<int>(sdkSecret.size()),
         reinterpret_cast<const unsigned char*>(signingInput.data()), signingInput.size(),
         digest, &digestLen);

    return signingInput + "." + base64UrlEncode(digest, digestLen);
}

// ---------------------------------------------------------------------
// Event handlers. Every pure virtual in each interface must be implemented
// (Linux build — WIN32-only methods are already excluded by the headers'
// own #if defined(WIN32) guards); most are intentional no-ops this service
// doesn't act on.
// ---------------------------------------------------------------------

class BotShareEvent : public IMeetingShareCtrlEvent {
public:
    void onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) override {
        qInfo() << "[share] onSharingStatus — share is live if this fires with our own source.";
    }
    void onFailedToStartShare() override {
        qCritical() << "[share] onFailedToStartShare — StartAppShare did not take. "
                       "Check the window-handle string format and that the target window "
                       "actually exists on the given X11 display.";
    }
    void onLockShareStatus(bool) override {}
    void onShareContentNotification(ZoomSDKSharingSourceInfo) override {}
    void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler*) override {}
    void onShareSettingTypeChangedNotification(ShareSettingType) override {}
    void onSharedVideoEnded() override {}
    void onVideoFileSharePlayError(ZoomSDKVideoFileSharePlayError) override {}
    void onOptimizingShareForVideoClipStatusChanged(ZoomSDKSharingSourceInfo) override {}
};

class BotMeetingEvent : public IMeetingServiceEvent {
public:
    BotMeetingEvent(IMeetingService* svc, std::string xWindowHandle)
        : m_meetingService(svc), m_xWindowHandle(std::move(xWindowHandle)) {}

    void onMeetingStatusChanged(MeetingStatus status, int iResult) override {
        qInfo() << "[meeting] status changed:" << status << "result:" << iResult;
        if (status != MEETING_STATUS_INMEETING) return;

        IMeetingShareController* shareCtrl = m_meetingService->GetMeetingShareController();
        if (!shareCtrl) {
            qCritical() << "[share] GetMeetingShareController() returned null.";
            return;
        }
        static BotShareEvent shareEvent; // lifetime: process lifetime
        shareCtrl->SetEvent(&shareEvent);

        // HWND is void* on Linux (zoom_sdk_def.h) standing in for the
        // formatted device-name string documented on StartAppShare.
        HWND fakeHwnd = reinterpret_cast<HWND>(const_cast<char*>(m_xWindowHandle.c_str()));
        SDKError err = shareCtrl->StartAppShare(fakeHwnd);
        qInfo() << "[share] StartAppShare(" << m_xWindowHandle.c_str() << ") -> SDKError" << err;
    }
    void onMeetingStatisticsWarningNotification(StatisticsWarningType) override {}
    void onMeetingParameterNotification(const MeetingParameter*) override {}
    void onSuspendParticipantsActivities() override {}
    void onAICompanionActiveChangeNotice(bool) override {}
    void onMeetingTopicChanged(const zchar_t*) override {}
    void onMeetingFullToWatchLiveStream(const zchar_t*) override {}
    void onUserNetworkStatusChanged(MeetingComponentType, ConnectionQuality, unsigned int, bool) override {}

private:
    IMeetingService* m_meetingService;
    std::string m_xWindowHandle;
};

class BotAuthEvent : public IAuthServiceEvent {
public:
    BotAuthEvent(std::string meetingNumber, std::string password, std::string xWindowHandle, std::string botName)
        : m_meetingNumber(std::move(meetingNumber)),
          m_password(std::move(password)),
          m_xWindowHandle(std::move(xWindowHandle)),
          m_botName(std::move(botName)) {}

    void onAuthenticationReturn(AuthResult ret) override {
        if (ret != AUTHRET_SUCCESS) {
            qCritical() << "[auth] failed, AuthResult =" << ret
                        << "(AUTHRET_JWTTOKENWRONG means the JWT/SDK-key-secret pair is bad — "
                           "check ZOOM_SDK_KEY/ZOOM_SDK_SECRET.)";
            // Found by actually running this path (bad credentials, on
            // purpose) rather than assumed: QCoreApplication::exit(1) here
            // unwinds app.exec(), falls off main(), and then segfaults
            // during static/global destruction — reproducible, and not
            // something the validated spike run ever exercised, since that
            // run authenticated successfully on the first real attempt and
            // never took this branch. Root cause is inside the vendor SDK's
            // own teardown, not this file's own state, so there's nothing
            // here to fix "properly" — std::_Exit skips C++ static
            // destruction and any SDK atexit handlers entirely, which is
            // the correct call for an already-erroring-out process anyway.
            std::_Exit(1);
        }
        qInfo() << "[auth] success — creating meeting service and joining.";

        IMeetingService* meetingService = nullptr;
        SDKError err = CreateMeetingService(&meetingService);
        if (err != SDKERR_SUCCESS || !meetingService) {
            qCritical() << "[meeting] CreateMeetingService failed:" << err;
            // Same crash-on-teardown reasoning as the auth-failure branch
            // above — not independently reproduced for this specific
            // branch, but the same QCoreApplication::exit(1)-after-SDK-
            // init pattern, so applying the same fix rather than waiting
            // to hit it separately.
            std::_Exit(1);
        }

        static BotMeetingEvent meetingEvent(meetingService, m_xWindowHandle);
        meetingService->SetEvent(&meetingEvent);

        JoinParam joinParam;
        joinParam.userType = SDK_UT_WITHOUT_LOGIN;
        joinParam.param.withoutloginuserJoin.meetingNumber = std::stoull(m_meetingNumber);
        joinParam.param.withoutloginuserJoin.userName = m_botName.c_str();
        joinParam.param.withoutloginuserJoin.psw = m_password.c_str();
        joinParam.param.withoutloginuserJoin.isVideoOff = true;
        joinParam.param.withoutloginuserJoin.isAudioOff = true;

        err = meetingService->Join(joinParam);
        qInfo() << "[meeting] Join() -> SDKError" << err;
    }
    void onLoginReturnWithReason(LOGINSTATUS, IAccountInfo*, LoginFailReason) override {}
    void onLogout() override {}
    void onZoomIdentityExpired() override {}
    void onZoomAuthIdentityExpired() override {}

private:
    std::string m_meetingNumber;
    std::string m_password;
    std::string m_xWindowHandle;
    std::string m_botName;
};

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);

    // Credentials come from environment, never argv/hardcoded — same rule
    // as every other credential in this project (docs/06-security-sandboxing.md).
    const char* sdkKey = std::getenv("ZOOM_SDK_KEY");
    const char* sdkSecret = std::getenv("ZOOM_SDK_SECRET");
    const char* meetingNumber = std::getenv("ZOOM_MEETING_NUMBER");
    const char* meetingPassword = std::getenv("ZOOM_MEETING_PASSWORD");
    // The X11 device-name string for the window to share, e.g.
    // ":99-0(0,0,1280,720)-<window_id>" — computed by start.sh from the
    // real Chromium window it launched against the shared Xvfb display.
    const char* xWindowHandle = std::getenv("ZOOM_SHARE_X_WINDOW_HANDLE");
    const char* botNameEnv = std::getenv("ZOOM_BOT_DISPLAY_NAME");
    const std::string botName = botNameEnv ? botNameEnv : "Data Cleanup Presentation Bot";

    if (!sdkKey || !sdkSecret || !meetingNumber || !meetingPassword || !xWindowHandle) {
        qCritical() << "Missing one of ZOOM_SDK_KEY / ZOOM_SDK_SECRET / "
                        "ZOOM_MEETING_NUMBER / ZOOM_MEETING_PASSWORD / "
                        "ZOOM_SHARE_X_WINDOW_HANDLE in the environment.";
        return 1;
    }

    InitParam initParam;
    initParam.strWebDomain = "https://zoom.us";
    initParam.enableLogByDefault = true;
    SDKError err = InitSDK(initParam);
    if (err != SDKERR_SUCCESS) {
        qCritical() << "InitSDK failed:" << err;
        return 1;
    }

    IAuthService* authService = nullptr;
    err = CreateAuthService(&authService);
    if (err != SDKERR_SUCCESS || !authService) {
        qCritical() << "CreateAuthService failed:" << err;
        return 1;
    }

    static BotAuthEvent authEvent(meetingNumber, meetingPassword, xWindowHandle, botName);
    authService->SetEvent(&authEvent);

    AuthContext authContext;
    const std::string jwt = buildSdkAuthJwt(sdkKey, sdkSecret);
    authContext.jwt_token = jwt.c_str();

    err = authService->SDKAuth(authContext);
    qInfo() << "SDKAuth() -> SDKError" << err << "(result arrives async via onAuthenticationReturn)";

    // Everything from here happens in the callbacks above, driven by Qt's
    // event loop, and keeps running indefinitely — this process IS the
    // long-running "stay joined and sharing" service, not a one-shot test.
    return app.exec();
}
