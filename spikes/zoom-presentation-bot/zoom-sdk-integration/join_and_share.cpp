// Zoom Linux Meeting SDK join + native screen-share, written against the
// REAL SDK headers (zoom-meeting-sdk-linux_x86_64-7.1.5.4432), not guessed.
//
// Confirmed by reading the actual headers in ../zoom-sdk/h/ (gitignored,
// proprietary — see ../README.md for how to obtain it):
//   - IAuthService::SDKAuth() takes an AuthContext with a jwt_token field.
//     The JWT payload must be {appKey, iat, exp, tokenExp}, HMAC-SHA256
//     signed with the SDK Secret (auth_service_interface.h, tagAuthContext).
//   - IMeetingService::Join() with userType SDK_UT_WITHOUT_LOGIN and
//     param.withoutloginuserJoin.{meetingNumber, psw, userName} joins
//     without a logged-in Zoom account (meeting_service_interface.h).
//   - IMeetingService::GetMeetingShareController()->StartAppShare(HWND)
//     is the native share call. On Linux, HWND is just `void*`
//     (zoom_sdk_def.h: `typedef void* HWND;`), and the SDK expects it to
//     be a pointer to a formatted device-name string:
//       "hostname:display_number-screen_number(x,y,width,height)-app_id"
//       e.g. ":99-0(0,0,1280,720)-<window_id>"
//     (meeting_sharing_interface.h, StartAppShare doc comment).
//   - libmeetingsdk.so links against the bundled Qt6 (ldd confirmed:
//     Qt6Core/Gui/Network/Qml/Quick/DBus) — the SDK is event-driven and
//     needs a running Qt event loop to deliver callbacks, so this can't be
//     a synchronous call-and-return `main()`.
//
// This file compiles against the real SDK (see CMakeLists.txt) but has NOT
// been run end-to-end — that step needs real SDK Key/Secret + a test
// meeting, which only the project owner can provide. See ../README.md for
// exactly what's still needed and how to run this once you have it.

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
// base64url (no padding), not standard base64. No dependency beyond OpenSSL
// (already required for HMAC), so this is hand-rolled rather than pulling
// in another library for one function.
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
    // Standard base64 uses '+'/'/' and '=' padding; JWT's base64url variant
    // swaps those for URL-safe chars and drops padding entirely.
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
    const long tokenExp = exp;               // session token expiry — same window for this spike

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
// (Linux build — the WIN32-only methods are already excluded by the
// headers' own #if defined(WIN32) guards) even though this spike only
// acts on a handful of them; the rest are intentional no-ops.
// ---------------------------------------------------------------------

class SpikeShareEvent : public IMeetingShareCtrlEvent {
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

class SpikeMeetingEvent : public IMeetingServiceEvent {
public:
    SpikeMeetingEvent(IMeetingService* svc, std::string xWindowHandle)
        : m_meetingService(svc), m_xWindowHandle(std::move(xWindowHandle)) {}

    void onMeetingStatusChanged(MeetingStatus status, int iResult) override {
        qInfo() << "[meeting] status changed:" << status << "result:" << iResult;
        if (status != MEETING_STATUS_INMEETING) return;

        // This is the actual moment this whole spike exists to validate:
        // can we get from "joined" to "sharing our own headless view" at all.
        IMeetingShareController* shareCtrl = m_meetingService->GetMeetingShareController();
        if (!shareCtrl) {
            qCritical() << "[share] GetMeetingShareController() returned null.";
            return;
        }
        static SpikeShareEvent shareEvent; // lifetime: process lifetime, fine for a spike
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
    // onAppSignalPanelUpdated is WIN32-only in meeting_service_interface.h
    // (guarded by #if defined(WIN32)) — IMeetingAppSignalHandler doesn't
    // exist on Linux, so this interface has one fewer method to implement
    // here than the Windows build would.

private:
    IMeetingService* m_meetingService;
    std::string m_xWindowHandle;
};

class SpikeAuthEvent : public IAuthServiceEvent {
public:
    SpikeAuthEvent(std::string meetingNumber, std::string password, std::string xWindowHandle)
        : m_meetingNumber(std::move(meetingNumber)),
          m_password(std::move(password)),
          m_xWindowHandle(std::move(xWindowHandle)) {}

    void onAuthenticationReturn(AuthResult ret) override {
        if (ret != AUTHRET_SUCCESS) {
            qCritical() << "[auth] failed, AuthResult =" << ret
                        << "(AUTHRET_JWTTOKENWRONG means the JWT/SDK-key-secret pair is bad — "
                           "check ../.env, don't hand-edit the JWT builder).";
            QCoreApplication::exit(1);
            return;
        }
        qInfo() << "[auth] success — creating meeting service and joining.";

        IMeetingService* meetingService = nullptr;
        SDKError err = CreateMeetingService(&meetingService);
        if (err != SDKERR_SUCCESS || !meetingService) {
            qCritical() << "[meeting] CreateMeetingService failed:" << err;
            QCoreApplication::exit(1);
            return;
        }

        static SpikeMeetingEvent meetingEvent(meetingService, m_xWindowHandle);
        meetingService->SetEvent(&meetingEvent);

        JoinParam joinParam;
        joinParam.userType = SDK_UT_WITHOUT_LOGIN;
        joinParam.param.withoutloginuserJoin.meetingNumber = std::stoull(m_meetingNumber);
        joinParam.param.withoutloginuserJoin.userName = "Data Cleanup Presentation Bot";
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
};

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);

    // Credentials come from environment, never argv/hardcoded — same rule
    // as every other credential in this project (see docs/06-security-sandboxing.md).
    // Populate these from a gitignored ../.env before running; see ../README.md.
    const char* sdkKey = std::getenv("ZOOM_SDK_KEY");
    const char* sdkSecret = std::getenv("ZOOM_SDK_SECRET");
    const char* meetingNumber = std::getenv("ZOOM_TEST_MEETING_NUMBER");
    const char* meetingPassword = std::getenv("ZOOM_TEST_MEETING_PASSWORD");
    // The X11 device-name string for the window to share, e.g.
    // ":99-0(0,0,1280,720)-<window_id>" — window_id comes from
    // `xdotool search --name <chromium-window-title>` against the same
    // Xvfb display stage 1 already proved works.
    const char* xWindowHandle = std::getenv("ZOOM_SHARE_X_WINDOW_HANDLE");

    if (!sdkKey || !sdkSecret || !meetingNumber || !meetingPassword || !xWindowHandle) {
        qCritical() << "Missing one of ZOOM_SDK_KEY / ZOOM_SDK_SECRET / "
                        "ZOOM_TEST_MEETING_NUMBER / ZOOM_TEST_MEETING_PASSWORD / "
                        "ZOOM_SHARE_X_WINDOW_HANDLE in the environment. "
                        "See ../README.md for how to obtain and set these.";
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

    static SpikeAuthEvent authEvent(meetingNumber, meetingPassword, xWindowHandle);
    authService->SetEvent(&authEvent);

    AuthContext authContext;
    const std::string jwt = buildSdkAuthJwt(sdkKey, sdkSecret);
    authContext.jwt_token = jwt.c_str();

    err = authService->SDKAuth(authContext);
    qInfo() << "SDKAuth() -> SDKError" << err << "(result arrives async via onAuthenticationReturn)";

    // Everything from here happens in the callbacks above, driven by Qt's
    // event loop — this is why the SDK can't be used from a bare
    // synchronous main(), per the ldd/RUNPATH findings in the file header.
    return app.exec();
}
