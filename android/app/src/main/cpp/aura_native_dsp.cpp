#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cctype>
#include <cstring>
#include <string>
#include <vector>

#define LOG_TAG "AuraNativeDSPPro"
#define ALOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define ALOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

namespace {

constexpr float PI = 3.14159265358979323846f;
constexpr float TWO_PI = 6.28318530717958647692f;
constexpr int BUFFER_SIZE = 131072;
constexpr int BUFFER_MASK = BUFFER_SIZE - 1;

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(v, hi));
}

inline float sanitize(float v) {
    return std::isfinite(v) ? v : 0.0f;
}

inline int16_t floatToI16(float v) {
    v = clampf(v, -1.0f, 1.0f);
    return static_cast<int16_t>(std::lrintf(v * (v < 0.0f ? 32768.0f : 32767.0f)));
}

inline float i16ToFloat(int16_t v) {
    return static_cast<float>(v) / 32768.0f;
}

enum class Mode {
    Normal = 0,
    Spatial3D = 1,
    Hifi = 2,
    Vocal = 3
};

struct StereoFrame {
    float l = 0.0f;
    float r = 0.0f;
};

class Biquad {
public:
    void reset() {
        z1 = 0.0f;
        z2 = 0.0f;
    }

    float process(float x) {
        float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return sanitize(y);
    }

    void setIdentity() {
        b0 = 1.0f;
        b1 = b2 = a1 = a2 = 0.0f;
    }

    void setLowPass(float sampleRate, float freq, float q) {
        float w0 = TWO_PI * clampf(freq, 10.0f, sampleRate * 0.45f) / sampleRate;
        float c = std::cos(w0);
        float s = std::sin(w0);
        float alpha = s / (2.0f * std::max(0.05f, q));
        float bb0 = (1.0f - c) * 0.5f;
        float bb1 = 1.0f - c;
        float bb2 = (1.0f - c) * 0.5f;
        float aa0 = 1.0f + alpha;
        float aa1 = -2.0f * c;
        float aa2 = 1.0f - alpha;
        setNormalized(bb0, bb1, bb2, aa0, aa1, aa2);
    }

    void setHighPass(float sampleRate, float freq, float q) {
        float w0 = TWO_PI * clampf(freq, 10.0f, sampleRate * 0.45f) / sampleRate;
        float c = std::cos(w0);
        float s = std::sin(w0);
        float alpha = s / (2.0f * std::max(0.05f, q));
        float bb0 = (1.0f + c) * 0.5f;
        float bb1 = -(1.0f + c);
        float bb2 = (1.0f + c) * 0.5f;
        float aa0 = 1.0f + alpha;
        float aa1 = -2.0f * c;
        float aa2 = 1.0f - alpha;
        setNormalized(bb0, bb1, bb2, aa0, aa1, aa2);
    }

    void setPeak(float sampleRate, float freq, float q, float gainDb) {
        float A = std::pow(10.0f, gainDb / 40.0f);
        float w0 = TWO_PI * clampf(freq, 10.0f, sampleRate * 0.45f) / sampleRate;
        float c = std::cos(w0);
        float s = std::sin(w0);
        float alpha = s / (2.0f * std::max(0.05f, q));
        float bb0 = 1.0f + alpha * A;
        float bb1 = -2.0f * c;
        float bb2 = 1.0f - alpha * A;
        float aa0 = 1.0f + alpha / A;
        float aa1 = -2.0f * c;
        float aa2 = 1.0f - alpha / A;
        setNormalized(bb0, bb1, bb2, aa0, aa1, aa2);
    }

    void setLowShelf(float sampleRate, float freq, float slope, float gainDb) {
        float A = std::pow(10.0f, gainDb / 40.0f);
        float w0 = TWO_PI * clampf(freq, 10.0f, sampleRate * 0.45f) / sampleRate;
        float c = std::cos(w0);
        float s = std::sin(w0);
        float S = std::max(0.05f, slope);
        float alpha = s * 0.5f * std::sqrt((A + 1.0f / A) * (1.0f / S - 1.0f) + 2.0f);
        float beta = 2.0f * std::sqrt(A) * alpha;
        float bb0 = A * ((A + 1.0f) - (A - 1.0f) * c + beta);
        float bb1 = 2.0f * A * ((A - 1.0f) - (A + 1.0f) * c);
        float bb2 = A * ((A + 1.0f) - (A - 1.0f) * c - beta);
        float aa0 = (A + 1.0f) + (A - 1.0f) * c + beta;
        float aa1 = -2.0f * ((A - 1.0f) + (A + 1.0f) * c);
        float aa2 = (A + 1.0f) + (A - 1.0f) * c - beta;
        setNormalized(bb0, bb1, bb2, aa0, aa1, aa2);
    }

    void setHighShelf(float sampleRate, float freq, float slope, float gainDb) {
        float A = std::pow(10.0f, gainDb / 40.0f);
        float w0 = TWO_PI * clampf(freq, 10.0f, sampleRate * 0.45f) / sampleRate;
        float c = std::cos(w0);
        float s = std::sin(w0);
        float S = std::max(0.05f, slope);
        float alpha = s * 0.5f * std::sqrt((A + 1.0f / A) * (1.0f / S - 1.0f) + 2.0f);
        float beta = 2.0f * std::sqrt(A) * alpha;
        float bb0 = A * ((A + 1.0f) + (A - 1.0f) * c + beta);
        float bb1 = -2.0f * A * ((A - 1.0f) + (A + 1.0f) * c);
        float bb2 = A * ((A + 1.0f) + (A - 1.0f) * c - beta);
        float aa0 = (A + 1.0f) - (A - 1.0f) * c + beta;
        float aa1 = 2.0f * ((A - 1.0f) - (A + 1.0f) * c);
        float aa2 = (A + 1.0f) - (A - 1.0f) * c - beta;
        setNormalized(bb0, bb1, bb2, aa0, aa1, aa2);
    }

private:
    void setNormalized(float bb0, float bb1, float bb2, float aa0, float aa1, float aa2) {
        float invA0 = 1.0f / std::max(1.0e-9f, aa0);
        b0 = bb0 * invA0;
        b1 = bb1 * invA0;
        b2 = bb2 * invA0;
        a1 = aa1 * invA0;
        a2 = aa2 * invA0;
    }

    float b0 = 1.0f;
    float b1 = 0.0f;
    float b2 = 0.0f;
    float a1 = 0.0f;
    float a2 = 0.0f;
    float z1 = 0.0f;
    float z2 = 0.0f;
};

class OnePole {
public:
    void reset() { y = 0.0f; }

    void configureLowPass(float sampleRate, float hz) {
        float safeHz = clampf(hz, 1.0f, sampleRate * 0.45f);
        a = 1.0f - std::exp(-2.0f * PI * safeHz / sampleRate);
    }

    float process(float x) {
        y += a * (x - y);
        return sanitize(y);
    }

    float value() const { return y; }

private:
    float a = 0.01f;
    float y = 0.0f;
};

class CombFilter {
public:
    explicit CombFilter(int size = 256) { resize(size); }

    void resize(int size) {
        buffer.assign(std::max(16, size), 0.0f);
        index = 0;
        store = 0.0f;
    }

    float process(float input) {
        float output = buffer[index];
        store = output * damp2 + store * damp1;
        buffer[index] = input + store * feedback;
        if (++index >= static_cast<int>(buffer.size())) index = 0;
        return sanitize(output);
    }

    void reset() {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
        index = 0;
        store = 0.0f;
    }

    float feedback = 0.82f;
    float damp1 = 0.32f;
    float damp2 = 0.68f;

private:
    std::vector<float> buffer;
    int index = 0;
    float store = 0.0f;
};

class AllpassFilter {
public:
    AllpassFilter(int size = 128, float fb = 0.5f) : feedback(fb) { resize(size); }

    void resize(int size) {
        buffer.assign(std::max(16, size), 0.0f);
        index = 0;
    }

    float process(float input) {
        float buffered = buffer[index];
        float output = -input + buffered;
        buffer[index] = input + buffered * feedback;
        if (++index >= static_cast<int>(buffer.size())) index = 0;
        return sanitize(output);
    }

    void reset() {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
        index = 0;
    }

private:
    std::vector<float> buffer;
    float feedback = 0.5f;
    int index = 0;
};

class SchroederMoorerReverb {
public:
    void configure(int sampleRate, int spread, float roomSize, float wetAmount, float damping) {
        static constexpr int combTuning[] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
        static constexpr int allpassTuning[] = {556, 441, 341, 225};
        float scale = static_cast<float>(sampleRate) / 44100.0f;

        combs.clear();
        allpasses.clear();
        for (int tuning : combTuning) {
            combs.emplace_back(std::max(16, static_cast<int>(std::lround((tuning + spread) * scale))));
        }
        for (int tuning : allpassTuning) {
            allpasses.emplace_back(std::max(16, static_cast<int>(std::lround((tuning + spread) * scale))), 0.50f);
        }

        room = clampf(roomSize, 0.45f, 0.96f);
        wet = clampf(wetAmount, 0.0f, 0.70f);
        damp = clampf(damping, 0.08f, 0.62f);
        for (auto &comb: combs) {
            comb.feedback = 0.68f + room * 0.25f;
            comb.damp1 = damp;
            comb.damp2 = 1.0f - damp;
        }
        reset();
    }

    float process(float input) {
        float x = clampf(input, -1.0f, 1.0f) * 0.33f;
        float sum = 0.0f;
        for (auto &comb: combs) sum += comb.process(x);
        float y = sum / std::max(1.0f, static_cast<float>(combs.size()));
        for (auto &allpass: allpasses) y = allpass.process(y);
        return sanitize(y * wet);
    }

    void reset() {
        for (auto &comb: combs) comb.reset();
        for (auto &ap: allpasses) ap.reset();
    }

private:
    std::vector<CombFilter> combs;
    std::vector<AllpassFilter> allpasses;
    float room = 0.8f;
    float wet = 0.3f;
    float damp = 0.32f;
};

class SoftKneeCompressor {
public:
    void configure(float sampleRate, float thresholdDb, float ratioValue, float attackMs, float releaseMs, float makeupDb) {
        sr = std::max(8000.0f, sampleRate);
        threshold = thresholdDb;
        ratio = std::max(1.0f, ratioValue);
        attack = std::exp(-1.0f / (sr * std::max(0.01f, attackMs) * 0.001f));
        release = std::exp(-1.0f / (sr * std::max(0.01f, releaseMs) * 0.001f));
        makeup = std::pow(10.0f, makeupDb / 20.0f);
    }

    StereoFrame process(StereoFrame x) {
        float peak = std::max(std::fabs(x.l), std::fabs(x.r));
        float levelDb = 20.0f * std::log10(std::max(1.0e-7f, peak));
        float over = levelDb - threshold;
        float gainDb = 0.0f;
        if (over > -knee * 0.5f && over < knee * 0.5f) {
            float t = over + knee * 0.5f;
            gainDb = (1.0f / ratio - 1.0f) * t * t / (2.0f * knee);
        } else if (over >= knee * 0.5f) {
            gainDb = over * (1.0f / ratio - 1.0f);
        }
        float target = std::pow(10.0f, gainDb / 20.0f);
        float coeff = target < gain ? attack : release;
        gain = coeff * gain + (1.0f - coeff) * target;
        return {x.l * gain * makeup, x.r * gain * makeup};
    }

    void reset() { gain = 1.0f; }

private:
    float sr = 44100.0f;
    float threshold = -12.0f;
    float ratio = 2.0f;
    float attack = 0.99f;
    float release = 0.999f;
    float makeup = 1.0f;
    float knee = 9.0f;
    float gain = 1.0f;
};

class PeakLimiter {
public:
    void configure(float sampleRate, float ceilingValue, float attackMs, float releaseMs) {
        sr = std::max(8000.0f, sampleRate);
        ceiling = clampf(ceilingValue, 0.65f, 0.99f);
        attack = std::exp(-1.0f / (sr * std::max(0.01f, attackMs) * 0.001f));
        release = std::exp(-1.0f / (sr * std::max(0.01f, releaseMs) * 0.001f));
    }

    StereoFrame process(StereoFrame x) {
        float peak = std::max(std::fabs(x.l), std::fabs(x.r));
        float target = peak > ceiling ? ceiling / std::max(peak, 1.0e-7f) : 1.0f;
        float coeff = target < gain ? attack : release;
        gain = coeff * gain + (1.0f - coeff) * target;
        x.l = clampf(x.l * gain, -0.985f, 0.985f);
        x.r = clampf(x.r * gain, -0.985f, 0.985f);
        return x;
    }

    void reset() { gain = 1.0f; }

private:
    float sr = 44100.0f;
    float ceiling = 0.96f;
    float attack = 0.98f;
    float release = 0.9995f;
    float gain = 1.0f;
};

class AuraDspEngine {
public:
    AuraDspEngine() { configure(44100, 2, 2); }

    void configure(int sr, int ch, int enc) {
        sampleRate = std::max(8000, sr);
        channels = ch;
        encoding = enc;

        configureFilters();
        flushKeepMode();
        ALOGI("Aura Native DSP Pro configured: sr=%d ch=%d enc=%d", sampleRate, channels, encoding);
    }

    void setMode(const std::string &modeName) {
        Mode newMode = Mode::Normal;
        std::string m = modeName;
        std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (m == "3d" || m == "spatial" || m == "surround" || m == "game" || m == "cinema3d") {
            newMode = Mode::Spatial3D;
        } else if (m == "hifi" || m == "hi-fi" || m == "lossless" || m == "dolby" || m == "atmos" || m == "cinema" || m == "live") {
            newMode = Mode::Hifi;
        } else if (m == "vocal" || m == "voice" || m == "vocal_only" || m == "clean_vocal") {
            newMode = Mode::Vocal;
        }

        if (mode != newMode) {
            mode = newMode;
            flushKeepMode();
        }
    }

    void setScreenOff(bool value) {
        screenOff = value;
    }

    void flush() { flushKeepMode(); }

    int process(const void *input, void *output, int frameCount, bool floatInput) {
        if (!input || !output || frameCount <= 0) return 0;

        if (floatInput) {
            const auto *in = static_cast<const float *>(input);
            auto *out = static_cast<float *>(output);
            for (int i = 0; i < frameCount; ++i) {
                StereoFrame y = processFrame(sanitize(in[i * 2]), sanitize(in[i * 2 + 1]));
                out[i * 2] = clampf(y.l, -1.0f, 1.0f);
                out[i * 2 + 1] = clampf(y.r, -1.0f, 1.0f);
            }
            return frameCount * 2 * static_cast<int>(sizeof(float));
        }

        const auto *in = static_cast<const int16_t *>(input);
        auto *out = static_cast<int16_t *>(output);
        for (int i = 0; i < frameCount; ++i) {
            StereoFrame y = processFrame(i16ToFloat(in[i * 2]), i16ToFloat(in[i * 2 + 1]));
            out[i * 2] = floatToI16(y.l);
            out[i * 2 + 1] = floatToI16(y.r);
        }
        return frameCount * 2 * static_cast<int>(sizeof(int16_t));
    }

private:
    int sampleRate = 44100;
    int channels = 2;
    int encoding = 2;
    Mode mode = Mode::Normal;
    bool screenOff = false;

    std::array<float, BUFFER_SIZE> delayL{};
    std::array<float, BUFFER_SIZE> delayR{};
    std::array<float, BUFFER_SIZE> delayM{};
    std::array<float, BUFFER_SIZE> delayS{};
    int delayPtr = 0;

    float fadeFrame = 0.0f;
    float loudnessEnv = 0.14f;
    float smoothGain = 1.0f;
    float motionPhase = 0.0f;
    float motionDepth = 0.0f;
    float objectMemory = 0.0f;

    OnePole spatialLow;
    OnePole spatialBody;
    OnePole spatialAir;
    OnePole hifiCrossL;
    OnePole hifiCrossR;
    OnePole vocalEnvFollower;

    Biquad normalHpL;
    Biquad normalHpR;
    Biquad normalAirL;
    Biquad normalAirR;

    Biquad hifiLowShelfL;
    Biquad hifiLowShelfR;
    Biquad hifiWarmL;
    Biquad hifiWarmR;
    Biquad hifiPresenceL;
    Biquad hifiPresenceR;
    Biquad hifiAirL;
    Biquad hifiAirR;

    Biquad vocalHp;
    Biquad vocalLp;
    Biquad vocalPresence;
    Biquad vocalBody;

    SchroederMoorerReverb hifiHallL;
    SchroederMoorerReverb hifiHallR;
    SchroederMoorerReverb spatialRoomL;
    SchroederMoorerReverb spatialRoomR;

    SoftKneeCompressor hifiComp;
    SoftKneeCompressor vocalComp;
    SoftKneeCompressor normalComp;
    PeakLimiter limiter;

    void configureFilters() {
        float sr = static_cast<float>(sampleRate);

        spatialLow.configureLowPass(sr, 115.0f);
        spatialBody.configureLowPass(sr, 2400.0f);
        spatialAir.configureLowPass(sr, 6200.0f);
        hifiCrossL.configureLowPass(sr, 700.0f);
        hifiCrossR.configureLowPass(sr, 700.0f);
        vocalEnvFollower.configureLowPass(sr, 28.0f);

        normalHpL.setHighPass(sr, 26.0f, 0.707f);
        normalHpR.setHighPass(sr, 26.0f, 0.707f);
        normalAirL.setHighShelf(sr, 8200.0f, 0.70f, 1.7f);
        normalAirR.setHighShelf(sr, 8200.0f, 0.70f, 1.7f);

        hifiLowShelfL.setLowShelf(sr, 72.0f, 0.70f, 6.2f);
        hifiLowShelfR.setLowShelf(sr, 72.0f, 0.70f, 6.2f);
        hifiWarmL.setPeak(sr, 260.0f, 0.78f, 1.8f);
        hifiWarmR.setPeak(sr, 260.0f, 0.78f, 1.8f);
        hifiPresenceL.setPeak(sr, 3200.0f, 0.88f, 3.6f);
        hifiPresenceR.setPeak(sr, 3200.0f, 0.88f, 3.6f);
        hifiAirL.setHighShelf(sr, 8800.0f, 0.58f, 5.4f);
        hifiAirR.setHighShelf(sr, 8800.0f, 0.58f, 5.4f);

        vocalHp.setHighPass(sr, 130.0f, 0.707f);
        vocalLp.setLowPass(sr, 7600.0f, 0.707f);
        vocalPresence.setPeak(sr, 2800.0f, 0.85f, 4.2f);
        vocalBody.setPeak(sr, 780.0f, 0.72f, 2.5f);

        hifiHallL.configure(sampleRate, 0, 0.92f, 0.48f, 0.30f);
        hifiHallR.configure(sampleRate, 29, 0.92f, 0.48f, 0.30f);
        spatialRoomL.configure(sampleRate, 7, 0.72f, 0.28f, 0.38f);
        spatialRoomR.configure(sampleRate, 31, 0.72f, 0.28f, 0.38f);

        hifiComp.configure(sr, -18.0f, 1.95f, 5.0f, 165.0f, 3.4f);
        vocalComp.configure(sr, -18.0f, 2.20f, 4.5f, 90.0f, 2.4f);
        normalComp.configure(sr, -12.0f, 1.45f, 8.0f, 130.0f, 1.1f);
        limiter.configure(sr, 0.955f, 0.65f, 42.0f);
    }

    void flushKeepMode() {
        delayL.fill(0.0f);
        delayR.fill(0.0f);
        delayM.fill(0.0f);
        delayS.fill(0.0f);
        delayPtr = 0;
        fadeFrame = 0.0f;
        loudnessEnv = 0.14f;
        smoothGain = 1.0f;
        motionPhase = 0.0f;
        motionDepth = 0.0f;
        objectMemory = 0.0f;

        spatialLow.reset();
        spatialBody.reset();
        spatialAir.reset();
        hifiCrossL.reset();
        hifiCrossR.reset();
        vocalEnvFollower.reset();

        normalHpL.reset();
        normalHpR.reset();
        normalAirL.reset();
        normalAirR.reset();
        hifiLowShelfL.reset();
        hifiLowShelfR.reset();
        hifiWarmL.reset();
        hifiWarmR.reset();
        hifiPresenceL.reset();
        hifiPresenceR.reset();
        hifiAirL.reset();
        hifiAirR.reset();
        vocalHp.reset();
        vocalLp.reset();
        vocalPresence.reset();
        vocalBody.reset();

        hifiHallL.reset();
        hifiHallR.reset();
        spatialRoomL.reset();
        spatialRoomR.reset();
        hifiComp.reset();
        vocalComp.reset();
        normalComp.reset();
        limiter.reset();
    }

    float coeff(float hz) const {
        float safeHz = clampf(hz, 1.0f, static_cast<float>(sampleRate) * 0.45f);
        return 1.0f - std::exp(-2.0f * PI * safeHz / static_cast<float>(sampleRate));
    }

    int delayMs(float ms) const {
        int d = static_cast<int>(std::lround(static_cast<float>(sampleRate) * ms * 0.001f));
        return std::max(1, std::min(d, BUFFER_SIZE - 1));
    }

    int clampDelay(int samples) const {
        return std::max(1, std::min(samples, BUFFER_SIZE - 1));
    }

    float getL(int samples) const { return delayL[(delayPtr - clampDelay(samples)) & BUFFER_MASK]; }
    float getR(int samples) const { return delayR[(delayPtr - clampDelay(samples)) & BUFFER_MASK]; }
    float getM(int samples) const { return delayM[(delayPtr - clampDelay(samples)) & BUFFER_MASK]; }
    float getS(int samples) const { return delayS[(delayPtr - clampDelay(samples)) & BUFFER_MASK]; }

    StereoFrame processFrame(float inL, float inR) {
        float mid = (inL + inR) * 0.5f;
        float side = (inL - inR) * 0.5f;

        delayL[delayPtr] = inL;
        delayR[delayPtr] = inR;
        delayM[delayPtr] = mid;
        delayS[delayPtr] = side;

        StereoFrame y;
        switch (mode) {
            case Mode::Spatial3D:
                y = processSpatial(mid, side);
                y = normalize(y, screenOff ? 0.275f : 0.315f, 0.74f, screenOff ? 3.35f : 4.40f);
                break;
            case Mode::Hifi:
                y = processHifi(inL, inR, mid, side);
                y = hifiComp.process(y);
                y = normalize(y, screenOff ? 0.320f : 0.375f, 0.82f, screenOff ? 3.85f : 5.40f);
                break;
            case Mode::Vocal:
                y = processVocal(inL, inR, mid, side);
                y = vocalComp.process(y);
                y = normalize(y, screenOff ? 0.230f : 0.260f, 0.82f, screenOff ? 3.50f : 4.40f);
                break;
            case Mode::Normal:
            default:
                y = processNormal(inL, inR);
                y = normalComp.process(y);
                y = normalize(y, 0.265f, 0.82f, 3.80f);
                break;
        }

        y = limiter.process(y);
        float fade = fadeMultiplier();
        y.l = sanitize(y.l * fade);
        y.r = sanitize(y.r * fade);

        delayPtr = (delayPtr + 1) & BUFFER_MASK;
        return y;
    }

    StereoFrame processNormal(float inL, float inR) {
        float l = normalHpL.process(inL);
        float r = normalHpR.process(inR);
        l = normalAirL.process(l);
        r = normalAirR.process(r);
        float mid = (l + r) * 0.5f;
        float side = (l - r) * 0.5f * 1.06f;
        return {(mid + side) * 1.04f, (mid - side) * 1.04f};
    }

    StereoFrame processHifi(float inL, float inR, float mid, float side) {
        // Dolby-like cinema chain, inspired by common open-source effect-chain design:
        // EQ -> bass enhancer -> exciter -> M/S widener -> virtual speakers -> room -> compressor/limiter.
        // This is NOT Dolby licensed code/codec; it is a real-time stereo cinema DSP tuned for Aura.

        // 1) Tone shaping: strong cinema bass, clearer presence, bright air.
        float l = hifiLowShelfL.process(inL);
        float r = hifiLowShelfR.process(inR);
        l = hifiWarmL.process(l);
        r = hifiWarmR.process(r);
        l = hifiPresenceL.process(l);
        r = hifiPresenceR.process(r);
        l = hifiAirL.process(l);
        r = hifiAirR.process(r);

        // 2) Speaker-like crossfeed: reduce in-head headphone feeling without collapsing stereo.
        float crossL = hifiCrossL.process(getR(delayMs(0.42f)));
        float crossR = hifiCrossR.process(getL(delayMs(0.42f)));
        l = l * 0.900f + crossL * 0.125f;
        r = r * 0.900f + crossR * 0.125f;

        float m = (l + r) * 0.5f;
        float s = (l - r) * 0.5f;

        // 3) Bass enhancer / psychoacoustic sub harmonics.
        // Low-end is kept mono and softly saturated so small phone/headphone drivers sound fuller.
        float delayedBass = getM(delayMs(3.5f));
        float bassDrive = std::tanh((m * 0.72f + delayedBass * 0.28f) * 2.65f);
        float cinemaBass = bassDrive * (screenOff ? 0.105f : 0.155f);
        m += cinemaBass;

        // 4) Crystalizer / exciter: add controlled high-frequency harmonics.
        // Derivative-style transient extraction; small amount only, then limited later.
        float transL = l - getL(delayMs(0.32f));
        float transR = r - getR(delayMs(0.32f));
        float excL = std::tanh(transL * 4.6f) * (screenOff ? 0.035f : 0.060f);
        float excR = std::tanh(transR * 4.6f) * (screenOff ? 0.035f : 0.060f);
        l += excL;
        r += excR;

        m = (l + r) * 0.5f;
        s = (l - r) * 0.5f;

        // 5) Cinema M/S width. High side content is widened more than low content.
        float sideEnergy = clampf(std::fabs(s) * 3.2f, 0.0f, 1.0f);
        float width = screenOff ? 1.42f : (1.68f + sideEnergy * 0.30f);
        float rearWidth = screenOff ? 0.72f : 1.08f;
        float heightWidth = screenOff ? 0.36f : 0.58f;

        // 6) Virtual 7.1.2 speaker bed rendered to stereo.
        // Front center carries vocal/lead; L/R and rear channels carry widened side and delayed ambience.
        StereoFrame center = renderVirtualSpeaker(m * 0.92f, 0.0f, 2.0f, 0.82f, 1.22f);
        StereoFrame frontL = renderVirtualSpeaker(s * width, -34.0f, 3.0f, 0.96f, 1.08f);
        StereoFrame frontR = renderVirtualSpeaker(-s * width, 34.0f, 3.0f, 0.96f, 1.08f);
        StereoFrame surroundL = renderVirtualSpeaker(getS(delayMs(18.0f)) * rearWidth + getM(delayMs(28.0f)) * 0.10f,
                                                    -112.0f, -3.0f, 1.20f, 0.92f);
        StereoFrame surroundR = renderVirtualSpeaker(-getS(delayMs(21.0f)) * rearWidth + getM(delayMs(31.0f)) * 0.10f,
                                                     112.0f, -3.0f, 1.20f, 0.92f);
        StereoFrame rear = renderVirtualSpeaker(getM(delayMs(46.0f)) * 0.10f + getS(delayMs(42.0f)) * 0.44f,
                                                178.0f, -5.0f, 1.42f, 0.76f);
        StereoFrame heightL = renderVirtualSpeaker((m * 0.10f + getS(delayMs(13.0f)) * heightWidth),
                                                   -52.0f, 42.0f, 1.35f, 0.70f);
        StereoFrame heightR = renderVirtualSpeaker((m * 0.10f - getS(delayMs(15.0f)) * heightWidth),
                                                   52.0f, 42.0f, 1.35f, 0.70f);

        // 7) Cinema room. Short pre-delay + dense Schroeder/Moorer hall.
        float hallInput = m * 0.36f + getM(delayMs(22.0f)) * 0.16f + s * 0.10f + getS(delayMs(36.0f)) * 0.08f;
        float hallL = hifiHallL.process(hallInput);
        float hallR = hifiHallR.process(hallInput * 0.92f - s * 0.06f);

        float roomMix = screenOff ? 0.26f : 0.46f;
        float directMix = screenOff ? 1.08f : 1.18f;
        float outL = (center.l + frontL.l + frontR.l + surroundL.l + surroundR.l + rear.l + heightL.l + heightR.l) * directMix
                   + hallL * roomMix
                   + getS(delayMs(59.0f)) * 0.040f
                   + cinemaBass * 0.26f;
        float outR = (center.r + frontL.r + frontR.r + surroundL.r + surroundR.r + rear.r + heightL.r + heightR.r) * directMix
                   + hallR * roomMix
                   - getS(delayMs(63.0f)) * 0.040f
                   + cinemaBass * 0.26f;

        // 8) Soft saturation gives more perceived loudness before compressor/limiter.
        outL = std::tanh(outL * 1.18f) * 0.94f;
        outR = std::tanh(outR * 1.18f) * 0.94f;

        return {outL, outR};
    }

    StereoFrame processSpatial(float mid, float side) {
        float low = spatialLow.process(mid);
        float body = spatialBody.process(mid);
        float high = mid - spatialAir.process(mid);

        float transientStrength = clampf(std::fabs(side) * 3.4f + std::fabs(high) * 1.8f, 0.0f, 1.0f);
        motionDepth += coeff(6.0f) * (transientStrength - motionDepth);

        float rotationHz = screenOff ? 0.070f : (0.095f + motionDepth * 0.075f);
        motionPhase += TWO_PI * rotationHz / static_cast<float>(sampleRate);
        if (motionPhase > TWO_PI) motionPhase -= TWO_PI;

        float az = std::sinf(motionPhase) * 135.0f;
        float depth = std::cosf(motionPhase);
        float moving = side * 1.46f + high * 0.38f + getS(delayMs(12.0f)) * 0.32f - getS(delayMs(21.0f)) * 0.13f;
        objectMemory += coeff(720.0f) * (moving - objectMemory);
        moving = moving * 0.72f + objectMemory * 0.28f;

        StereoFrame fl = renderVirtualSpeaker(body * 0.30f + side * 0.58f, -32.0f, 0.0f, 0.96f, 1.00f);
        StereoFrame fr = renderVirtualSpeaker(body * 0.30f - side * 0.58f, 32.0f, 0.0f, 0.96f, 1.00f);
        StereoFrame sl = renderVirtualSpeaker(getS(delayMs(17.0f)) * 0.58f, -96.0f, -2.0f, 1.12f, 1.06f);
        StereoFrame sr = renderVirtualSpeaker(-getS(delayMs(19.0f)) * 0.58f, 96.0f, -2.0f, 1.12f, 1.06f);
        StereoFrame rear = renderVirtualSpeaker(getM(delayMs(35.0f)) * 0.12f + getS(delayMs(31.0f)) * 0.52f, depth > 0.0f ? 150.0f : -150.0f, -6.0f, 1.30f, 0.88f);
        StereoFrame obj = renderVirtualSpeaker(moving, az, 3.0f + depth * 8.0f, 0.92f, 1.22f);

        float revIn = getS(delayMs(46.0f)) * 0.20f + getM(delayMs(66.0f)) * 0.08f;
        float revL = spatialRoomL.process(revIn);
        float revR = spatialRoomR.process(-revIn);

        if (screenOff) {
            // Lock-screen safe path keeps spatial cues but reduces expensive/reverberant density.
            float width = side * 1.30f;
            float center = mid * 0.48f + low * 0.05f;
            return {center + width + obj.l * 0.55f + rear.l * 0.22f + revL * 0.09f,
                    center - width + obj.r * 0.55f + rear.r * 0.22f + revR * 0.09f};
        }

        float center = mid * 0.18f + low * 0.06f;
        float outL = center + fl.l + fr.l + sl.l + sr.l + rear.l + obj.l + revL * 0.22f;
        float outR = center + fl.r + fr.r + sl.r + sr.r + rear.r + obj.r + revR * 0.22f;
        return {outL * 1.08f, outR * 1.08f};
    }

    StereoFrame renderVirtualSpeaker(float source, float azimuthDeg, float elevationDeg, float distance, float focus) {
        float az = azimuthDeg * PI / 180.0f;
        float el = elevationDeg * PI / 180.0f;
        float side = std::sinf(az);
        float front = std::cosf(az);
        float height = std::sinf(el);
        float absHeight = std::fabs(height);

        int itd = static_cast<int>(std::lround(delayMs(0.74f) * side * (1.0f - absHeight * 0.48f)));
        float delayed = getM(std::abs(itd) + 1);
        float earL = itd > 0 ? delayed : source;
        float earR = itd < 0 ? delayed : source;

        float ild = 0.84f * (1.0f - absHeight * 0.34f);
        float leftGain = std::sqrt(clampf(0.5f * (1.0f - side * ild), 0.035f, 0.985f));
        float rightGain = std::sqrt(clampf(0.5f * (1.0f + side * ild), 0.035f, 0.985f));

        float rearAmount = clampf(-front, 0.0f, 1.0f);
        float frontAmount = clampf(front, 0.0f, 1.0f);
        float rearComb = getM(delayMs(10.4f)) * -0.20f + getM(delayMs(16.7f)) * 0.13f - getM(delayMs(23.2f)) * 0.055f;
        float frontCue = source + (source - getM(delayMs(1.25f))) * 0.11f * frontAmount;
        float rearCue = source * (1.0f - rearAmount * 0.22f) + rearComb * rearAmount;
        float heightCue = (source - getM(delayMs(2.55f))) * height * 0.18f;
        float shaped = frontCue * frontAmount + rearCue * rearAmount + source * (1.0f - frontAmount - rearAmount) * 0.55f + heightCue;

        // A compact HRIR-like multi-tap reflection set. These are hand-tuned taps, not copied HRIR data.
        float reflection = getM(delayMs(17.0f + std::fabs(azimuthDeg) * 0.035f)) * 0.030f
                         + getS(delayMs(24.0f + std::fabs(elevationDeg) * 0.025f)) * 0.023f
                         - getM(delayMs(31.0f + rearAmount * 7.0f)) * 0.012f;

        float distanceGain = 1.0f / std::max(0.72f, distance);
        float focusGain = clampf(focus, 0.35f, 1.35f);
        float outL = (earL * 0.46f + shaped * 0.54f) * leftGain + reflection;
        float outR = (earR * 0.46f + shaped * 0.54f) * rightGain - reflection * 0.68f;
        return {outL * distanceGain * focusGain, outR * distanceGain * focusGain};
    }

    StereoFrame processVocal(float inL, float inR, float mid, float side) {
        float center = mid;
        center = vocalHp.process(center);
        center = vocalLp.process(center);
        center = vocalBody.process(center);
        center = vocalPresence.process(center);

        // Real-time center-channel vocal enhancer: side suppression + dynamic confidence gate.
        float sideEnergy = std::fabs(side);
        float midEnergy = std::fabs(mid) + 0.025f;
        float centerConfidence = 1.0f - clampf(sideEnergy / midEnergy, 0.0f, 1.0f);
        float env = vocalEnvFollower.process(std::fabs(center));
        float activity = clampf(env * 8.0f, 0.15f, 1.0f);
        float gate = (0.34f + centerConfidence * 0.78f) * activity;

        float ambience = side * (screenOff ? 0.018f : 0.026f);
        float out = center * gate * 2.05f;
        return {out + ambience, out - ambience};
    }

    StereoFrame normalize(StereoFrame x, float targetRms, float minGain, float maxGain) {
        float rms = std::sqrt((x.l * x.l + x.r * x.r) * 0.5f + 1.0e-9f);
        float envCoeff = rms > loudnessEnv ? coeff(18.0f) : coeff(2.4f);
        loudnessEnv += envCoeff * (rms - loudnessEnv);
        float desired = targetRms / std::max(loudnessEnv, 0.018f);
        desired = clampf(desired, minGain, maxGain);
        float gainCoeff = desired < smoothGain ? coeff(55.0f) : coeff(4.2f);
        smoothGain += gainCoeff * (desired - smoothGain);
        return {x.l * smoothGain, x.r * smoothGain};
    }

    float fadeMultiplier() {
        float fadeFrames = std::max(1.0f, static_cast<float>(sampleRate) * 0.018f);
        if (fadeFrame >= fadeFrames) return 1.0f;
        float x = fadeFrame / fadeFrames;
        fadeFrame += 1.0f;
        return x * x * (3.0f - 2.0f * x);
    }
};

AuraDspEngine *ptrFromHandle(jlong handle) {
    return reinterpret_cast<AuraDspEngine *>(static_cast<uintptr_t>(handle));
}

std::string jstringToString(JNIEnv *env, jstring value) {
    if (!value) return "normal";
    const char *chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return "normal";
    std::string out(chars);
    env->ReleaseStringUTFChars(value, chars);
    return out;
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeCreate(JNIEnv *, jclass) {
    auto *engine = new AuraDspEngine();
    return static_cast<jlong>(reinterpret_cast<uintptr_t>(engine));
}

extern "C" JNIEXPORT void JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeConfigure(
        JNIEnv *, jclass, jlong handle, jint sampleRate, jint channels, jint encoding) {
    auto *engine = ptrFromHandle(handle);
    if (engine) engine->configure(sampleRate, channels, encoding);
}

extern "C" JNIEXPORT void JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeSetMode(
        JNIEnv *env, jclass, jlong handle, jstring mode) {
    auto *engine = ptrFromHandle(handle);
    if (engine) engine->setMode(jstringToString(env, mode));
}

extern "C" JNIEXPORT void JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeSetScreenOff(
        JNIEnv *, jclass, jlong handle, jboolean screenOff) {
    auto *engine = ptrFromHandle(handle);
    if (engine) engine->setScreenOff(screenOff == JNI_TRUE);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeProcess(
        JNIEnv *env,
        jclass,
        jlong handle,
        jobject inputBuffer,
        jobject outputBuffer,
        jint frameCount,
        jboolean floatInput) {
    auto *engine = ptrFromHandle(handle);
    if (!engine || !inputBuffer || !outputBuffer || frameCount <= 0) return 0;

    void *input = env->GetDirectBufferAddress(inputBuffer);
    void *output = env->GetDirectBufferAddress(outputBuffer);
    if (!input || !output) {
        ALOGE("DirectBuffer address is null. JNI DSP requires direct ByteBuffer.");
        return 0;
    }

    return engine->process(input, output, frameCount, floatInput == JNI_TRUE);
}

extern "C" JNIEXPORT void JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeFlush(JNIEnv *, jclass, jlong handle) {
    auto *engine = ptrFromHandle(handle);
    if (engine) engine->flush();
}

extern "C" JNIEXPORT void JNICALL
Java_com_YWJ_Aura_MusicService_00024NativeAuraProcessor_nativeRelease(JNIEnv *, jclass, jlong handle) {
    auto *engine = ptrFromHandle(handle);
    delete engine;
}
