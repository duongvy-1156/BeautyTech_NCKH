// ============================================================================
// PHẦN 1 (NÂNG CẤP): TIỀN XỬ LÝ ẢNH, LỌC NHIỄU MEDIAN, GÓC 3D & DÁNG MẶT
// ============================================================================

const videoElement = document.getElementById('input-video');
const imageElement = document.getElementById('uploaded-image');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');

// Các nút điều khiển chính
const btnCamera = document.getElementById('btn-camera');
const fileUpload = document.getElementById('file-upload');
const btnRecord = document.getElementById('btn-record');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnClearAll = document.getElementById('btn-clear-all');

// Các công tắc bật/tắt Tiền xử lý (GĐ 1) & Đồ họa AR (GĐ 4)
const chkAwb = document.getElementById('chk-awb');
const chkMesh = document.getElementById('chk-mesh');
const chkMakeup = document.getElementById('chk-Makeup') || document.getElementById('chk-makeup');
const chkFoundation = document.getElementById('chk-foundation');
const chkContour = document.getElementById('chk-contour');
const chkEyeBrow = document.getElementById('chk-eye-brow');
const chkPbr = document.getElementById('chk-pbr');
const rngAlpha = document.getElementById('rng-alpha');
const valAlpha = document.getElementById('val-alpha');

// Biến trạng thái thực nghiệm
let cameraInstance = null;
let isCameraRunning = false;
let lastFrameTime = performance.now();
let currentFps = 0;
let currentLatency = 0;
let sampleCounter = 0;
let latestAnalysisData = null;
let experimentRecords = [];

rngAlpha.addEventListener('input', (e) => {
    valAlpha.textContent = e.target.value;
    if (!isCameraRunning && imageElement.src) processStaticImage();
});

[chkAwb, chkMesh, chkMakeup, chkFoundation, chkContour, chkEyeBrow, chkPbr].forEach(chk => {
    if (chk) {
        chk.addEventListener('change', () => {
            if (!isCameraRunning && imageElement.src) processStaticImage();
        });
    }
});

// ----------------------------------------------------------------------------
// CÁC HÀM XỬ LÝ ẢNH & HÌNH HỌC 3D CHUYÊN SÂU (GIAI ĐOẠN 1 & GIAI ĐOẠN 2)
// ----------------------------------------------------------------------------

// 1. Khoảng cách Euclidean 3D chuẩn hóa giữa 2 điểm mốc (Mục 2.5)
function euclideanDistance3D(p1, p2, width, height) {
    const dx = (p1.x - p2.x) * width;
    const dy = (p1.y - p2.y) * height;
    const dz = (p1.z - p2.z) * width;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 2. Thuật toán Cân bằng trắng tự động Gray World kết hợp White Patch (Mục 2.3)
// Khử hiện tượng ám vàng (đèn sợi đốt) hoặc ám xanh của môi trường trước khi đo Undertone
function computeGrayWorldGains(ctx, landmarks, width, height) {
    const topX = Math.max(0, Math.floor(landmarks[234].x * width));
    const topY = Math.max(0, Math.floor(landmarks[10].y * height));
    const boxW = Math.min(width - topX, Math.max(20, Math.floor((landmarks[454].x - landmarks[234].x) * width)));
    const boxH = Math.min(height - topY, Math.max(20, Math.floor((landmarks[152].y - landmarks[10].y) * height)));

    const data = ctx.getImageData(topX, topY, boxW, boxH).data;
    let sumR = 0, sumG = 0, sumB = 0, count = 0;

    // Bước nhảy mẫu để đảm bảo tốc độ thời gian thực < 1ms
    for (let i = 0; i < data.length; i += 16) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        // Loại bỏ các điểm quá tối (bóng đổ/tóc) hoặc quá chói (bóng đèn)
        if (lum > 35 && lum < 240) {
            sumR += r;
            sumG += g;
            sumB += b;
            count++;
        }
    }

    if (count === 0) return { kR: 1, kG: 1, kB: 1 };
    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;
    const grayAvg = (avgR + avgG + avgB) / 3;

    // Hệ số bù cân bằng trắng có giới hạn an toàn (damping) để giữ sắc tố tự nhiên của da
    const clampGain = (g) => Math.min(1.22, Math.max(0.82, 1 + (g - 1) * 0.55));
    return {
        kR: clampGain(grayAvg / (avgR || 1)),
        kG: clampGain(grayAvg / (avgG || 1)),
        kB: clampGain(grayAvg / (avgB || 1))
    };
}

// 3. Bộ lọc Trung vị (Median Filter) & Loại bỏ điểm nhiễu ngoại lai (Mục 2.6)
// Loại bỏ vệt bóng dầu (specular highlight), tóc mái che trán hoặc đốm mụn/tàn nhang
function sampleRegionMedianRGB(ctx, landmark, width, height, radius = 7, awbGains = { kR: 1, kG: 1, kB: 1 }) {
    const cx = Math.min(Math.max(Math.floor(landmark.x * width), radius), width - radius - 1);
    const cy = Math.min(Math.max(Math.floor(landmark.y * height), radius), height - radius - 1);
    const size = radius * 2;
    const imgData = ctx.getImageData(cx - radius, cy - radius, size, size).data;

    let pixels = [];
    for (let i = 0; i < imgData.length; i += 4) {
        const r = Math.min(255, Math.round(imgData[i] * awbGains.kR));
        const g = Math.min(255, Math.round(imgData[i + 1] * awbGains.kG));
        const b = Math.min(255, Math.round(imgData[i + 2] * awbGains.kB));
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        pixels.push({ r, g, b, lum });
    }

    // Sắp xếp theo độ sáng (Luminance) để lấy phân vị trung tâm (Interquartile 25% - 75%)
    // Tự động loại bỏ 25% điểm tối nhất (tóc mái, nốt ruồi, mụn) và 25% điểm sáng nhất (bóng dầu)
    pixels.sort((a, b) => a.lum - b.lum);
    const startIdx = Math.floor(pixels.length * 0.25);
    const endIdx = Math.ceil(pixels.length * 0.75);
    const validPixels = pixels.slice(startIdx, endIdx);

    const mid = Math.floor(validPixels.length / 2);
    return {
        r: validPixels[mid].r,
        g: validPixels[mid].g,
        b: validPixels[mid].b
    };
}

// 4. Ước lượng Tư thế đầu 3D (3D Head Pose: Roll - Yaw - Pitch) & Bù sai số phối cảnh (Mục 2.3 & 2.5)
function estimate3DHeadPose(landmarks, width, height) {
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const noseTip = landmarks[1];
    const forehead = landmarks[10];
    const chin = landmarks[152];
    const leftCheek = landmarks[234];
    const rightCheek = landmarks[454];

    // Trục Roll (Nghiêng đầu trái/phải 2D)
    const rollRad = Math.atan2((rightEye.y - leftEye.y) * height, (rightEye.x - leftEye.x) * width);
    const rollDeg = rollRad * (180 / Math.PI);

    // Trục Yaw (Xoay mặt sang trái/phải 3D dựa trên tỷ lệ bất đối xứng mũi - hai má và trục Z)
    const distLeft = Math.hypot((noseTip.x - leftCheek.x) * width, (noseTip.y - leftCheek.y) * height);
    const distRight = Math.hypot((rightEye.x - noseTip.x) * width, (rightCheek.y - noseTip.y) * height);
    const yawAsym = (distLeft - distRight) / ((distLeft + distRight) || 1);
    const yawDeg = Math.max(-65, Math.min(65, yawAsym * 90));

    // Trục Pitch (Ngẩng mặt / Cúi đầu 3D dựa trên tỷ lệ trán - mũi - cằm và độ sâu Z)
    const upperHalf = Math.hypot((noseTip.x - forehead.x) * width, (noseTip.y - forehead.y) * height);
    const lowerHalf = Math.hypot((chin.x - noseTip.x) * width, (chin.y - noseTip.y) * height);
    const pitchRatio = (upperHalf - lowerHalf * 1.12) / ((upperHalf + lowerHalf) || 1);
    const pitchDeg = Math.max(-55, Math.min(55, pitchRatio * 95));

    const isFrontal = (Math.abs(yawDeg) < 18 && Math.abs(pitchDeg) < 16);
    return {
        roll: parseFloat(rollDeg.toFixed(1)),
        yaw: parseFloat(yawDeg.toFixed(1)),
        pitch: parseFloat(pitchDeg.toFixed(1)),
        isFrontal: isFrontal
    };
}

// 5. Phân loại Dáng khuôn mặt (Face Shape Classification) & Chuẩn hóa Tỷ lệ vàng 3D (Mục 2.5)
function analyzeFaceGeometryAndShape(landmarks, width, height, pose3D) {
    // Bù trừ độ co hẹp phối cảnh (Perspective Foreshortening Compensation) bằng hàm cos(Yaw) và cos(Pitch)
    const yawCos = Math.max(0.65, Math.cos(pose3D.yaw * Math.PI / 180));
    const pitchCos = Math.max(0.70, Math.cos(pose3D.pitch * Math.PI / 180));

    // Chiều dài mặt (Trán #10 -> Cằm #152) đã bù góc ngẩng/cúi Pitch
    const rawFaceLength = euclideanDistance3D(landmarks[10], landmarks[152], width, height);
    const faceLength = rawFaceLength / pitchCos;

    // Độ rộng 3 tầng: Trán (#103 - #332), Gò má (#234 - #454), Xương hàm (#172 - #397) đã bù góc xoay Yaw
    const foreheadWidth = euclideanDistance3D(landmarks[103], landmarks[332], width, height) / yawCos;
    const cheekboneWidth = euclideanDistance3D(landmarks[234], landmarks[454], width, height) / yawCos;
    const jawlineWidth = euclideanDistance3D(landmarks[172], landmarks[397], width, height) / yawCos;

    const goldenRatio = faceLength / (cheekboneWidth || 1);
    const goldenDiffPercent = Math.abs((goldenRatio - 1.618) / 1.618 * 100).toFixed(1);

    const jawToCheekRatio = jawlineWidth / (cheekboneWidth || 1);
    const foreheadToCheekRatio = foreheadWidth / (cheekboneWidth || 1);

    // Phân loại 5 Dáng khuôn mặt kinh điển dựa trên tỷ lệ nhân trắc học
    let faceShape = "Trái xoan (Oval)";
    if (goldenRatio >= 1.68) {
        faceShape = "Mặt Dài (Oblong)";
    } else if (goldenRatio <= 1.32 && jawToCheekRatio < 0.84) {
        faceShape = "Mặt Tròn (Round)";
    } else if (jawToCheekRatio >= 0.86) {
        faceShape = "Mặt Vuông (Square)";
    } else if (cheekboneWidth > foreheadWidth * 1.12 && jawToCheekRatio < 0.78) {
        faceShape = "Kim cương (Diamond)";
    }

    return {
        faceLength,
        faceWidth: cheekboneWidth,
        goldenRatio,
        goldenDiffPercent,
        faceShape,
        jawToCheekRatio: jawToCheekRatio.toFixed(2)
    };
}

// 6. Chuyển đổi không gian màu RGB sang HSV và CIELAB (Mục 2.6)
function rgbToHsvAndLab(r, g, b) {
    let rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
    let max = Math.max(rNorm, gNorm, bNorm), min = Math.min(rNorm, gNorm, bNorm);
    let d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;

    if (max !== min) {
        switch (max) {
            case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
            case gNorm: h = (bNorm - rNorm) / d + 2; break;
            case bNorm: h = (rNorm - gNorm) / d + 4; break;
        }
        h /= 6;
    }

    const toLinear = (c) => (c > 0.04045) ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    let rl = toLinear(rNorm), gl = toLinear(gNorm), bl = toLinear(bNorm);
    let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
    let y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.00000;
    let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

    const fLab = (t) => (t > 0.008856) ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    let fx = fLab(x), fy = fLab(y), fz = fLab(z);

    let L_star = (116 * fy) - 16;
    let a_star = 500 * (fx - fy);
    let b_star = 200 * (fy - fz);

    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        v: Math.round(v * 100),
        L: L_star.toFixed(1),
        a: a_star.toFixed(1),
        b: b_star.toFixed(1)
    };
}

function getLuminance(rgb) {
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

// ----------------------------------------------------------------------------
// GIAI ĐOẠN 3: HỆ CHUYÊN GIA DỰA TRÊN LUẬT (KẾT HỢP UNDERTONE + VISUAL WEIGHT + DÁNG MẶT)
// ----------------------------------------------------------------------------
function evaluateMakeupRules(undertone, visualWeight, faceShape = "Trái xoan (Oval)") {
    let styleName = "";
    let description = "";
    let palette = {};

    // Gợi ý kỹ thuật tạo khối chuyên biệt theo từng Dáng khuôn mặt
    let contourAdvice = "";
    if (faceShape.includes("Tròn")) {
        contourAdvice = "Đánh khối xéo từ mang tai xuống hốc má và bắt sáng dọc sống mũi/cằm để kéo dài gương mặt.";
    } else if (faceShape.includes("Vuông")) {
        contourAdvice = "Tập trung phủ khối đậm làm mềm hai góc xương hàm và tán má hồng tròn nhẹ ở gò má.";
    } else if (faceShape.includes("Dài")) {
        contourAdvice = "Phủ khối nhẹ ở chân tóc trán và đỉnh cằm, đánh má hồng nằm ngang để cân bằng chiều dài mặt.";
    } else if (faceShape.includes("Kim cương")) {
        contourAdvice = "Làm dịu phần gò má nhô cao bằng bronzer nhẹ và bắt sáng vùng trán/cằm để tạo độ đầy đặn.";
    } else {
        contourAdvice = "Khuôn mặt cân đối chuẩn Trái xoan, chỉ cần phẩy nhẹ contour ôm theo cấu trúc xương tự nhiên.";
    }

    if (undertone === "Lạnh (Cool)" && visualWeight === "Thấp (Low)") {
        styleName = "Icy Makeup / Clean Girl";
        description = `Tone pastel lạnh, ánh nhũ bạc trong trẻo, nền căng bóng tối giản. (${contourAdvice})`;
        palette = {
            foundationHex: "#F7E7E2",
            contourHex: "#9E7B70",
            highlightHex: "#FFFFFF",
            eyebrowHex: "#5A4D4C",
            eyelinerHex: "#3A2E39",
            eyeshadowHex: "#C5B4E3",
            blushHex: "#F497B6",
            lipstickHex: "#E06C88",
            glossiness: 0.85,
            wingIntensity: 0.6,
            aegyoSal: false
        };
    } else if (undertone === "Ấm (Warm)" && visualWeight === "Cao (High)") {
        styleName = "Makeup kiểu Tây / Latin";
        description = `Nhấn mạnh contour rõ nét, bronzer tone ấm, chân mày xếch sắc sảo và son nude cam đất lì. (${contourAdvice})`;
        palette = {
            foundationHex: "#E6BE9A",
            contourHex: "#6E4228",
            highlightHex: "#FFE6B3",
            eyebrowHex: "#3B2314",
            eyelinerHex: "#140D0B",
            eyeshadowHex: "#8D5524",
            blushHex: "#C86D51",
            lipstickHex: "#B55A44",
            glossiness: 0.15,
            wingIntensity: 1.35,
            aegyoSal: false
        };
    } else if ((undertone === "Trung tính (Neutral)" || undertone === "Lạnh (Cool)") && visualWeight === "Cao (High)") {
        styleName = "Makeup Douyin / Smokey Eyes";
        description = `Nền trắng sứ mịn lì, tạo bọng mắt giả (aegyo-sal) nhũ sáng, eyeliner mảnh dài và son bóng. (${contourAdvice})`;
        palette = {
            foundationHex: "#F9ECE8",
            contourHex: "#8C6D68",
            highlightHex: "#FFF5FA",
            eyebrowHex: "#4A3B3C",
            eyelinerHex: "#1C1417",
            eyeshadowHex: "#6D4C5C",
            blushHex: "#E15B76",
            lipstickHex: "#C91E4A",
            glossiness: 0.92,
            wingIntensity: 1.15,
            aegyoSal: true
        };
    } else {
        styleName = "Peach Makeup / Makeup No-Makeup";
        description = `Sử dụng gam hồng cam đào nhẹ nhàng, nữ tính, nền mỏng ẩm tiệp da tự nhiên. (${contourAdvice})`;
        palette = {
            foundationHex: "#F3D7BF",
            contourHex: "#9C735B",
            highlightHex: "#FFF2E2",
            eyebrowHex: "#5C4335",
            eyelinerHex: "#3D291E",
            eyeshadowHex: "#E6A18C",
            blushHex: "#F38D76",
            lipstickHex: "#EB735B",
            glossiness: 0.65,
            wingIntensity: 0.5,
            aegyoSal: false
        };
    }

    return { styleName, description, contourAdvice, palette };
}

// ============================================================================
// PHẦN 2: GIAI ĐOẠN 4 - KẾT XUẤT ĐỒ HỌA AR ĐẦY ĐỦ CÁC LỚP MỸ PHẨM
// ============================================================================

// 1. Tập chỉ số điểm mốc (Landmark Indices) từ lưới 468 điểm MediaPipe
const FACE_OVAL_INDICES = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LEFT_EYE_HOLE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE_HOLE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const MOUTH_OUTER_HOLE = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

const LIP_UPPER_INDICES = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78];
const LIP_LOWER_INDICES = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];

const LEFT_EYE_SHADOW_INDICES = [33, 246, 161, 160, 159, 158, 157, 173, 133, 221, 222, 223, 224, 225, 113];
const RIGHT_EYE_SHADOW_INDICES = [263, 466, 388, 387, 386, 385, 384, 398, 362, 441, 442, 443, 444, 445, 342];

const LEFT_EYEBROW_INDICES = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const RIGHT_EYEBROW_INDICES = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];

const LEFT_EYELINER_INDICES = [133, 173, 157, 158, 159, 160, 161, 246, 33];
const RIGHT_EYELINER_INDICES = [362, 398, 384, 385, 386, 387, 388, 466, 263];

const LEFT_AEGYOSAL_INDICES = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const RIGHT_AEGYOSAL_INDICES = [263, 249, 390, 373, 374, 380, 381, 382, 362];

// 2. Lớp Kem nền (Foundation Layer) - Bảo toàn vân da & cắt rỗng mắt, môi
function drawFoundationLayer(ctx, landmarks, width, height, hexColor, alpha) {
    ctx.save();
    ctx.beginPath();

    const addPath = (indices) => {
        indices.forEach((idx, i) => {
            const pt = landmarks[idx];
            if (i === 0) ctx.moveTo(pt.x * width, pt.y * height);
            else ctx.lineTo(pt.x * width, pt.y * height);
        });
        ctx.closePath();
    };

    // Vẽ khung khuôn mặt và khoét lỗ vùng mắt, miệng bằng quy tắc 'evenodd'
    addPath(FACE_OVAL_INDICES);
    addPath(LEFT_EYE_HOLE);
    addPath(RIGHT_EYE_HOLE);
    addPath(MOUTH_OUTER_HOLE);

    ctx.fillStyle = hexColor;
    ctx.globalAlpha = alpha * 0.42;
    ctx.globalCompositeOperation = 'soft-light';
    ctx.filter = 'blur(4px)';
    ctx.fill('evenodd');

    // Lớp phủ mỏng điều chỉnh sắc độ nền
    ctx.globalAlpha = alpha * 0.18;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fill('evenodd');
    ctx.restore();
}

// 3. Lớp Tạo khối (Contour) & Bắt sáng (Highlight) theo điểm mốc sinh học
function drawContourAndHighlight(ctx, landmarks, width, height, contourHex, highlightHex, alpha, faceWidth) {
    ctx.save();

    // Hàm hỗ trợ vẽ vệt tạo khối/bắt sáng dọc theo danh sách điểm mốc
    const drawSoftStroke = (indices, color, lineWidth, opacity, blendMode, blurPx) => {
        ctx.save();
        ctx.beginPath();
        indices.forEach((idx, i) => {
            const pt = landmarks[idx];
            if (i === 0) ctx.moveTo(pt.x * width, pt.y * height);
            else ctx.lineTo(pt.x * width, pt.y * height);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = blendMode;
        ctx.filter = `blur(${blurPx}px)`;
        ctx.stroke();
        ctx.restore();
    };

    // Tạo khối xương hàm & hốc má hai bên (Contour)
    drawSoftStroke([234, 93, 132, 58, 172, 136], contourHex, faceWidth * 0.065, alpha * 0.45, 'multiply', 6);
    drawSoftStroke([454, 323, 361, 288, 397, 365], contourHex, faceWidth * 0.065, alpha * 0.45, 'multiply', 6);

    // Tạo khối hai bên sống mũi
    drawSoftStroke([193, 122, 196, 3, 51], contourHex, faceWidth * 0.025, alpha * 0.38, 'multiply', 3.5);
    drawSoftStroke([417, 351, 419, 248, 281], contourHex, faceWidth * 0.025, alpha * 0.38, 'multiply', 3.5);

    // Bắt sáng (Highlight) dọc sống mũi (#168 -> #4)
    drawSoftStroke([168, 6, 197, 195, 5, 4], highlightHex, faceWidth * 0.022, alpha * 0.65, 'screen', 2.5);

    // Bắt sáng vùng trán (#151), cằm (#152) và đỉnh gò má (#116, #345)
    const highlightSpots = [
        { idx: 151, r: faceWidth * 0.11 }, // Giữa trán
        { idx: 152, r: faceWidth * 0.07 }, // Đỉnh cằm
        { idx: 116, r: faceWidth * 0.08 }, // Đỉnh gò má trái
        { idx: 345, r: faceWidth * 0.08 }  // Đỉnh gò má phải
    ];

    highlightSpots.forEach(spot => {
        const pt = landmarks[spot.idx];
        const cx = pt.x * width, cy = pt.y * height;
        const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, spot.r);
        grad.addColorStop(0, highlightHex);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.globalAlpha = alpha * 0.5;
        ctx.globalCompositeOperation = 'screen';
        ctx.beginPath();
        ctx.arc(cx, cy, spot.r, 0, 2 * Math.PI);
        ctx.fill();
    });

    ctx.restore();
}

// 4. Lớp Chân mày (Eyebrow), Kẻ mắt (Eyeliner) và Bọng mắt (Aegyo-sal Douyin)
function drawEyebrowsAndEyeliner(ctx, landmarks, width, height, palette, alpha, faceWidth) {
    // 4.1. Vẽ Chân mày hai bên
    drawSemanticPolygon(ctx, landmarks, LEFT_EYEBROW_INDICES, width, height, palette.eyebrowHex, alpha * 0.55, 'multiply', 2.2);
    drawSemanticPolygon(ctx, landmarks, RIGHT_EYEBROW_INDICES, width, height, palette.eyebrowHex, alpha * 0.55, 'multiply', 2.2);

    // 4.2. Kẻ viền mắt trên (Eyeliner) + Kéo đuôi mắt sắc sảo (Winged Liner)
    const drawWingedLiner = (indices, isLeft) => {
        ctx.save();
        ctx.beginPath();
        indices.forEach((idx, i) => {
            const pt = landmarks[idx];
            if (i === 0) ctx.moveTo(pt.x * width, pt.y * height);
            else ctx.lineTo(pt.x * width, pt.y * height);
        });

        // Tính vector kéo đuôi eyeliner ở khóe mắt ngoài
        const outerCorner = landmarks[indices[indices.length - 1]];
        const prevPt = landmarks[indices[indices.length - 2]];
        const dirX = (outerCorner.x - prevPt.x) * width;
        const wingLen = faceWidth * 0.038 * (palette.wingIntensity || 0.8);
        const wingX = (outerCorner.x * width) + (isLeft ? -Math.abs(dirX) - wingLen : Math.abs(dirX) + wingLen);
        const wingY = (outerCorner.y * height) - (wingLen * 0.55);
        ctx.lineTo(wingX, wingY);

        ctx.strokeStyle = palette.eyelinerHex;
        ctx.lineWidth = Math.max(1.8, faceWidth * 0.012);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = Math.min(0.92, alpha * 1.15);
        ctx.globalCompositeOperation = 'source-over';
        ctx.filter = 'blur(0.4px)';
        ctx.stroke();
        ctx.restore();
    };

    drawWingedLiner(LEFT_EYELINER_INDICES, true);
    drawWingedLiner(RIGHT_EYELINER_INDICES, false);

    // 4.3. Vẽ Bọng mắt giả nhũ sáng (Aegyo-sal) đặc trưng cho phong cách Douyin
    if (palette.aegyoSal) {
        const drawAegyoSal = (indices) => {
            ctx.save();
            ctx.beginPath();
            indices.forEach((idx, i) => {
                const pt = landmarks[idx];
                const x = pt.x * width;
                const y = (pt.y * height) + (faceWidth * 0.018); // Dịch nhẹ xuống dưới mi dưới
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.strokeStyle = "#FFF0F5";
            ctx.lineWidth = faceWidth * 0.018;
            ctx.lineCap = 'round';
            ctx.globalAlpha = alpha * 0.7;
            ctx.globalCompositeOperation = 'screen';
            ctx.filter = 'blur(1.5px)';
            ctx.stroke();
            ctx.restore();
        };
        drawAegyoSal(LEFT_AEGYOSAL_INDICES);
        drawAegyoSal(RIGHT_AEGYOSAL_INDICES);
    }
}

// 5. Hàm vẽ đa giác ngữ nghĩa (Dùng cho Phấn mắt & Chân mày)
function drawSemanticPolygon(ctx, landmarks, indices, width, height, hexColor, alpha, blendMode = 'multiply', blurPx = 1.8) {
    ctx.save();
    ctx.beginPath();
    indices.forEach((idx, i) => {
        const pt = landmarks[idx];
        if (i === 0) ctx.moveTo(pt.x * width, pt.y * height);
        else ctx.lineTo(pt.x * width, pt.y * height);
    });
    ctx.closePath();
    ctx.fillStyle = hexColor;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = blendMode;
    ctx.filter = `blur(${blurPx}px)`;
    ctx.fill();
    ctx.restore();
}

// 6. Hàm đánh Má hồng lan tỏa tự nhiên (Blush Radial Blending)
function drawBlushRadial(ctx, landmark, width, height, radius, hexColor, alpha) {
    const cx = landmark.x * width;
    const cy = landmark.y * height;
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
    grad.addColorStop(0, hexColor);
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.globalAlpha = alpha * 0.55;
    ctx.globalCompositeOperation = 'multiply';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
}

// 7. Cơ chế Hòa trộn màu môi đa lớp (Multi-pass Lip Blending - Không bị xỉn màu nude/sáng)
function drawMultiPassLip(ctx, landmarks, indices, width, height, hexColor, alpha) {
    ctx.save();
    ctx.beginPath();
    indices.forEach((idx, i) => {
        const pt = landmarks[idx];
        if (i === 0) ctx.moveTo(pt.x * width, pt.y * height);
        else ctx.lineTo(pt.x * width, pt.y * height);
    });
    ctx.closePath();
    ctx.filter = 'blur(1.2px)';

    // Lớp 1 (Base Pass): Trung hòa sắc tố môi và làm mịn bằng 'soft-light'
    ctx.fillStyle = hexColor;
    ctx.globalAlpha = alpha * 0.65;
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fill();

    // Lớp 2 (Pigment Pass): Lên chuẩn sắc độ màu son (kể cả tông Nude, Cam đào hay Đỏ đậm)
    ctx.globalAlpha = alpha * 0.52;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fill();
    ctx.restore();
}

// 8. Hiệu ứng phản xạ ánh sáng PBR Shader (Specular Highlight trên môi)
function drawPbrSpecularHighlight(ctx, landmarks, width, height, glossiness, alpha) {
    if (glossiness < 0.35) return; // Son lì (matte) không tạo bóng gương
    ctx.save();
    const pLeft = landmarks[87];
    const pCenter = landmarks[14];
    const pRight = landmarks[317];

    const x = pCenter.x * width;
    const y = (pCenter.y * height) + 3.5;
    const rx = Math.abs((pRight.x - pLeft.x) * width) * 0.36;
    const ry = Math.max(rx * 0.22, 2.5);

    const specGrad = ctx.createRadialGradient(x, y, 1, x, y, rx);
    specGrad.addColorStop(0, `rgba(255, 255, 255, ${glossiness * alpha * 0.8})`);
    specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = specGrad;
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
}

// ============================================================================
// PHẦN 3 (NÂNG CẤP): LUỒNG XỬ LÝ CHÍNH 3D, CHỐNG TREO CAMERA & BẢNG THỰC NGHIỆM
// ============================================================================

// Tạo bí danh tương thích ngược và bọc bảo vệ tọa độ lấy mẫu ảnh không bao giờ vượt khung hình
function safeSampleMedianRGB(ctx, landmark, width, height, radius = 6, awbGains = { kR: 1, kG: 1, kB: 1 }) {
    try {
        if (typeof sampleRegionMedianRGB === 'function') {
            return sampleRegionMedianRGB(ctx, landmark, width, height, radius, awbGains);
        }
    } catch (e) {}
    return { r: 215, g: 175, b: 155 };
}

function safeComputeGrayWorld(ctx, landmarks, width, height) {
    try {
        if (chkAwb && !chkAwb.checked) return { kR: 1, kG: 1, kB: 1 };
        if (typeof computeGrayWorldGains === 'function') {
            return computeGrayWorldGains(ctx, landmarks, width, height);
        }
    } catch (e) {}
    return { kR: 1, kG: 1, kB: 1 };
}

function onFaceMeshResults(results) {
    const startProcessTime = performance.now();
    const width = canvasElement.width;
    const height = canvasElement.height;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, width, height);
    canvasCtx.drawImage(results.image, 0, 0, width, height);

    try {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
            const landmarks = results.multiFaceLandmarks[0];

            // --- BƯỚC 1: ƯỚC LƯỢNG TƯ THẾ ĐẦU 3D (ROLL - YAW - PITCH) & CÂN BẰNG TRẮNG (Giai đoạn 1) ---
            const pose3D = estimate3DHeadPose(landmarks, width, height);
            const awbGains = safeComputeGrayWorld(canvasCtx, landmarks, width, height);

            // --- BƯỚC 2: PHÂN TÍCH HÌNH HỌC 3D, TỶ LỆ VÀNG & PHÂN LOẠI 5 DÁNG MẶT (Giai đoạn 2) ---
            const geoData = analyzeFaceGeometryAndShape(landmarks, width, height, pose3D);
            const faceLength = geoData.faceLength;
            const faceWidth = geoData.faceWidth;
            const goldenRatioMeasured = geoData.goldenRatio;
            const goldenDiffPercent = geoData.goldenDiffPercent;
            const faceShape = geoData.faceShape;

            const lipThicknessRatio = euclideanDistance3D(landmarks[13], landmarks[17], width, height) / (faceLength || 1);

            // --- BƯỚC 3: LỌC NHIỄU MEDIAN VÙNG DA, ĐO TƯƠNG PHẢN & UNDERTONE (Mục 2.6) ---
            const foreheadRGB = safeSampleMedianRGB(canvasCtx, landmarks[151], width, height, 6, awbGains);
            const leftCheekRGB = safeSampleMedianRGB(canvasCtx, landmarks[50], width, height, 6, awbGains);
            const rightCheekRGB = safeSampleMedianRGB(canvasCtx, landmarks[280], width, height, 6, awbGains);
            const lipSampleRGB = safeSampleMedianRGB(canvasCtx, landmarks[14], width, height, 4, awbGains);
            const eyeSampleRGB = safeSampleMedianRGB(canvasCtx, landmarks[159], width, height, 4, awbGains);

            const skinRGB = {
                r: Math.round((foreheadRGB.r + leftCheekRGB.r + rightCheekRGB.r) / 3),
                g: Math.round((foreheadRGB.g + leftCheekRGB.g + rightCheekRGB.g) / 3),
                b: Math.round((foreheadRGB.b + leftCheekRGB.b + rightCheekRGB.b) / 3)
            };

            const colorMetrics = rgbToHsvAndLab(skinRGB.r, skinRGB.g, skinRGB.b);

            const skinLum = getLuminance(skinRGB);
            const featureLum = (getLuminance(lipSampleRGB) + getLuminance(eyeSampleRGB)) / 2;
            const facialContrast = Math.abs(skinLum - featureLum) / (skinLum || 1);

            const visualWeight = (facialContrast > 0.16 || lipThicknessRatio > 0.085) ? "Cao (High)" : "Thấp (Low)";

            const bStarVal = parseFloat(colorMetrics.b);
            const aStarVal = parseFloat(colorMetrics.a);
            let undertone = "Trung tính (Neutral)";
            if (bStarVal > 16.5 && (bStarVal - aStarVal) > 4.5) {
                undertone = "Ấm (Warm)";
            } else if (bStarVal < 12.5 || aStarVal > bStarVal) {
                undertone = "Lạnh (Cool)";
            }

            // --- BƯỚC 4: HỆ CHUYÊN GIA IF-THEN KẾT HỢP DÁNG MẶT & XUẤT JSON TIẾNG VIỆT (Giai đoạn 3) ---
            const expertResult = evaluateMakeupRules(undertone, visualWeight, faceShape);
            const currentAlpha = parseFloat(rngAlpha.value);

            const jsonPackage = {
                "Thời gian phân tích": new Date().toLocaleString('vi-VN'),
                "Tiền xử lý ảnh (Giai đoạn 1)": {
                    "Cân bằng trắng Gray World (AWB)": (chkAwb && chkAwb.checked) ? `Bật (kR:${awbGains.kR.toFixed(2)}, kG:${awbGains.kG.toFixed(2)}, kB:${awbGains.kB.toFixed(2)})` : "Tắt",
                    "Bộ lọc nhiễu da": "Median Interquartile Filter (Loại bỏ bóng dầu/mụn/tóc)",
                    "Tư thế đầu 3D (Roll / Yaw / Pitch)": `${pose3D.roll}° / ${pose3D.yaw}° / ${pose3D.pitch}° (${pose3D.isFrontal ? "Chính diện chuẩn" : "Đã bù phối cảnh 3D"})`
                },
                "Thông số sinh học khuôn mặt (Giai đoạn 2)": {
                    "Dáng khuôn mặt (Face Shape)": faceShape,
                    "Tỷ lệ nhân trắc (Tỷ lệ vàng)": `${goldenRatioMeasured.toFixed(2)} (Sai số: ${goldenDiffPercent}%)`,
                    "Tỷ lệ Xương hàm / Gò má": geoData.jawToCheekRatio,
                    "Độ tương phản khuôn mặt": parseFloat(facialContrast.toFixed(3)),
                    "Sức hút thị giác": visualWeight,
                    "Sắc tố da (Undertone)": undertone,
                    "Không gian màu da": `HSV(${colorMetrics.h}°, ${colorMetrics.s}%, ${colorMetrics.v}%) | CIELAB b*(${colorMetrics.b})`
                },
                "Hệ chuyên gia tư vấn (Giai đoạn 3)": {
                    "Phong cách trang điểm đề xuất": expertResult.styleName,
                    "Chiến lược tạo khối theo dáng mặt": expertResult.contourAdvice
                },
                "Cấu hình kết xuất đồ họa AR (Giai đoạn 4)": {
                    "Mã màu kem nền (Foundation HEX)": expertResult.palette.foundationHex,
                    "Mã màu tạo khối & bắt sáng (Contour/Highlight)": `${expertResult.palette.contourHex} / ${expertResult.palette.highlightHex}`,
                    "Mã màu chân mày & kẻ mắt (Brow/Liner)": `${expertResult.palette.eyebrowHex} / ${expertResult.palette.eyelinerHex}`,
                    "Mã màu phấn mắt (Eyeshadow HEX)": expertResult.palette.eyeshadowHex,
                    "Mã màu má hồng (Blush HEX)": expertResult.palette.blushHex,
                    "Mã màu son môi 2 lớp (Lipstick HEX)": expertResult.palette.lipstickHex,
                    "Hiệu ứng bọng mắt (Aegyo-sal)": expertResult.palette.aegyoSal ? "Kích hoạt (Nhũ sáng)" : "Không áp dụng",
                    "Độ mờ lớp trang điểm (Opacity)": currentAlpha,
                    "Độ bóng vật liệu PBR (Glossiness)": expertResult.palette.glossiness
                }
            };

            // --- BƯỚC 5: KẾT XUẤT ĐỒ HỌA AR ĐA LỚP (Giai đoạn 4) ---
            if (chkMakeup && chkMakeup.checked) {
                if (!chkFoundation || chkFoundation.checked) {
                    drawFoundationLayer(canvasCtx, landmarks, width, height, expertResult.palette.foundationHex, currentAlpha);
                }
                if (!chkContour || chkContour.checked) {
                    drawContourAndHighlight(
                        canvasCtx, landmarks, width, height,
                        expertResult.palette.contourHex, expertResult.palette.highlightHex,
                        currentAlpha, faceWidth
                    );
                }
                drawSemanticPolygon(canvasCtx, landmarks, LEFT_EYE_SHADOW_INDICES, width, height, expertResult.palette.eyeshadowHex, currentAlpha * 0.58);
                drawSemanticPolygon(canvasCtx, landmarks, RIGHT_EYE_SHADOW_INDICES, width, height, expertResult.palette.eyeshadowHex, currentAlpha * 0.58);

                if (!chkEyeBrow || chkEyeBrow.checked) {
                    drawEyebrowsAndEyeliner(canvasCtx, landmarks, width, height, expertResult.palette, currentAlpha, faceWidth);
                }

                const cheekRadius = faceWidth * 0.16;
                drawBlushRadial(canvasCtx, landmarks[50], width, height, cheekRadius, expertResult.palette.blushHex, currentAlpha);
                drawBlushRadial(canvasCtx, landmarks[280], width, height, cheekRadius, expertResult.palette.blushHex, currentAlpha);

                drawMultiPassLip(canvasCtx, landmarks, LIP_UPPER_INDICES, width, height, expertResult.palette.lipstickHex, currentAlpha);
                drawMultiPassLip(canvasCtx, landmarks, LIP_LOWER_INDICES, width, height, expertResult.palette.lipstickHex, currentAlpha);

                if (!chkPbr || chkPbr.checked) {
                    drawPbrSpecularHighlight(canvasCtx, landmarks, width, height, expertResult.palette.glossiness, currentAlpha);
                }
            }

            // Vẽ lưới 468 điểm 3D
            if (chkMesh && chkMesh.checked) {
                canvasCtx.fillStyle = "rgba(56, 189, 248, 0.75)";
                for (let i = 0; i < landmarks.length; i++) {
                    const pt = landmarks[i];
                    canvasCtx.beginPath();
                    canvasCtx.arc(pt.x * width, pt.y * height, 1.2, 0, 2 * Math.PI);
                    canvasCtx.fill();
                }
            }

            // Tính toán độ trễ (Latency) và FPS
            const now = performance.now();
            currentLatency = (now - startProcessTime).toFixed(1);
            currentFps = Math.min(60, Math.round(1000 / Math.max(1, now - lastFrameTime)));
            lastFrameTime = now;

            // Cập nhật lên giao diện
            document.getElementById('fps-badge').textContent = `FPS: ${currentFps}`;
            document.getElementById('latency-badge').textContent = `Độ trễ: ${currentLatency} ms`;
            document.getElementById('val-angle').textContent = `R:${pose3D.roll}° | Y:${pose3D.yaw}° | P:${pose3D.pitch}°`;
            document.getElementById('val-golden').textContent = `${faceShape} - ${goldenRatioMeasured.toFixed(2)} (${goldenDiffPercent}%)`;
            document.getElementById('val-contrast').textContent = facialContrast.toFixed(3);
            document.getElementById('val-weight').textContent = visualWeight;
            document.getElementById('val-color-space').textContent = `H:${colorMetrics.h}° S:${colorMetrics.s}% V:${colorMetrics.v}% | b*:${colorMetrics.b}`;
            document.getElementById('val-undertone').textContent = undertone;
            document.getElementById('val-style-name').textContent = `${expertResult.styleName} (${faceShape})`;
            document.getElementById('val-style-desc').textContent = expertResult.description;
            document.getElementById('json-output').textContent = JSON.stringify(jsonPackage, null, 2);

            latestAnalysisData = {
                goldenRatio: `${faceShape} | ${goldenRatioMeasured.toFixed(2)} (${goldenDiffPercent}%)`,
                contrast: facialContrast.toFixed(3),
                visualWeight: visualWeight,
                colorInfo: `HSV(${colorMetrics.h},${colorMetrics.s},${colorMetrics.v}) / b*=${colorMetrics.b}`,
                undertone: undertone,
                style: expertResult.styleName,
                latency: currentLatency,
                fps: currentFps
            };
        }
    } catch (err) {
        console.warn("Bỏ qua khung hình nhiễu:", err);
    }

    canvasCtx.restore();
}

// ----------------------------------------------------------------------------
// KHỞI TẠO MÔ HÌNH AI MEDIAPIPE FACE MESH (468 ĐIỂM 3D)
// ----------------------------------------------------------------------------
const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});

faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
});

faceMesh.onResults(onFaceMeshResults);

// Bật/tắt Camera thời gian thực (Kèm cơ chế chống kẹt luồng video)
btnCamera.addEventListener('click', async () => {
    if (!isCameraRunning) {
        isCameraRunning = true;
        btnCamera.textContent = "Tạm Dừng Camera";
        if (!cameraInstance) {
            cameraInstance = new Camera(videoElement, {
                onFrame: async () => {
                    if (isCameraRunning && videoElement.readyState >= 2) {
                        try {
                            await faceMesh.send({ image: videoElement });
                        } catch (e) {
                            console.warn("Đang đồng bộ khung hình camera...", e);
                        }
                    }
                },
                width: 640,
                height: 480
            });
        }
        await cameraInstance.start();
    } else {
        isCameraRunning = false;
        btnCamera.textContent = "Bật Camera Thời Gian Thực";
        if (cameraInstance) await cameraInstance.stop();
    }
});

// Tải ảnh mẫu tĩnh để phân tích
async function processStaticImage() {
    lastFrameTime = performance.now() - 28;
    if (imageElement.complete && imageElement.naturalWidth > 0) {
        await faceMesh.send({ image: imageElement });
    }
}

fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (isCameraRunning && cameraInstance) {
        isCameraRunning = false;
        btnCamera.textContent = "Bật Camera Thời Gian Thực";
        cameraInstance.stop();
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        imageElement.onload = () => {
            canvasElement.width = 640;
            canvasElement.height = Math.round(640 * (imageElement.height / imageElement.width));
            processStaticImage();
        };
        imageElement.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

// ----------------------------------------------------------------------------
// MODULE QUẢN LÝ BẢNG SỐ LIỆU THỰC NGHIỆM (THÊM / XÓA DÒNG / XÓA HẾT / XUẤT CSV)
// ----------------------------------------------------------------------------
function renderExperimentTable() {
    const tbody = document.getElementById('exp-tbody');
    tbody.innerHTML = "";

    experimentRecords.forEach((record, index) => {
        record.id = `Mẫu #${index + 1}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${record.id}</strong></td>
            <td>${record.goldenRatio}</td>
            <td>${record.contrast}</td>
            <td>${record.visualWeight}</td>
            <td>${record.colorInfo}</td>
            <td><strong>${record.undertone}</strong></td>
            <td style="color:#be185d; font-weight:700;">${record.style}</td>
            <td>${record.latency} ms</td>
            <td>${record.fps} FPS</td>
            <td><button class="btn-delete-row" onclick="deleteSingleRecord(${index})">Xóa</button></td>
        `;
        tbody.appendChild(tr);
    });
}

window.deleteSingleRecord = function(index) {
    experimentRecords.splice(index, 1);
    sampleCounter = experimentRecords.length;
    renderExperimentTable();
};

btnRecord.addEventListener('click', () => {
    if (!latestAnalysisData) {
        alert("Hệ thống chưa nhận diện được khuôn mặt nào! Hãy bật Camera hoặc tải ảnh lên trước.");
        return;
    }
    sampleCounter = experimentRecords.length + 1;
    const record = {
        id: `Mẫu #${sampleCounter}`,
        ...latestAnalysisData
    };
    experimentRecords.push(record);
    renderExperimentTable();
});

if (btnClearAll) {
    btnClearAll.addEventListener('click', () => {
        if (experimentRecords.length === 0) {
            alert("Bảng hiện tại đang trống!");
            return;
        }
        if (confirm("Bạn có chắc chắn muốn xóa toàn bộ dữ liệu trong bảng thực nghiệm không?")) {
            experimentRecords = [];
            sampleCounter = 0;
            renderExperimentTable();
        }
    });
}

btnExportCsv.addEventListener('click', () => {
    if (experimentRecords.length === 0) {
        alert("Chưa có mẫu thực nghiệm nào trong bảng!");
        return;
    }
    let csvContent = "\uFEFFMẫu thử,Dáng mặt & Tỷ lệ vàng,Độ tương phản,Visual Weight,Chỉ số HSV/Lab,Undertone,Phong cách đề xuất,Độ trễ (ms),Tốc độ (FPS)\n";
    experimentRecords.forEach(r => {
        csvContent += `"${r.id}","${r.goldenRatio}","${r.contrast}","${r.visualWeight}","${r.colorInfo}","${r.undertone}","${r.style}","${r.latency}","${r.fps}"\n`;
    });
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Ket_Qua_Thuc_Nghiem_BeautyTech.csv';
    a.click();
});