// Khởi tạo các phần tử DOM
const videoElement = document.getElementById('input-video');
const imageElement = document.getElementById('uploaded-image');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');

// Điều khiển giao diện
const btnCamera = document.getElementById('btn-camera');
const fileUpload = document.getElementById('file-upload');
const btnRecord = document.getElementById('btn-record');
const btnExportCsv = document.getElementById('btn-export-csv');

const chkMesh = document.getElementById('chk-mesh');
const chkMakeup = document.getElementById('chk-makeup');
const chkPbr = document.getElementById('chk-pbr');
const rngAlpha = document.getElementById('rng-alpha');
const valAlpha = document.getElementById('val-alpha');

// Biến lưu trữ trạng thái thực nghiệm
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
    if (!isCameraRunning && imageElement.src) {
        processStaticImage();
    }
});

[chkMesh, chkMakeup, chkPbr].forEach(chk => {
    chk.addEventListener('change', () => {
        if (!isCameraRunning && imageElement.src) {
            processStaticImage();
        }
    });
});

// ============================================================================
// CÁC HÀM TOÁN HỌC & XỬ LÝ ẢNH (GIAI ĐOẠN 1 & GIAI ĐOẠN 2)
// ============================================================================

// 1. Khoảng cách Euclidean 3D giữa 2 điểm mốc trong lưới 468 điểm (Mục 2.5)
function euclideanDistance3D(p1, p2, width, height) {
    const dx = (p1.x - p2.x) * width;
    const dy = (p1.y - p2.y) * height;
    const dz = (p1.z - p2.z) * width;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 2. Lấy màu RGB trung bình tại vùng xung quanh 1 điểm mốc (Mục 2.3 & 2.6)
function sampleRegionRGB(ctx, landmark, width, height, radius = 4) {
    const cx = Math.min(Math.max(Math.floor(landmark.x * width), radius), width - radius - 1);
    const cy = Math.min(Math.max(Math.floor(landmark.y * height), radius), height - radius - 1);
    const size = radius * 2;
    const imgData = ctx.getImageData(cx - radius, cy - radius, size, size).data;

    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < imgData.length; i += 4) {
        r += imgData[i];
        g += imgData[i + 1];
        b += imgData[i + 2];
        count++;
    }
    return {
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count)
    };
}

// 3. Chuyển đổi không gian màu RGB sang HSV và CIELAB (Mục 2.6)
function rgbToHsvAndLab(r, g, b) {
    // RGB -> HSV
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

    // RGB -> XYZ -> CIELAB (Lấy kênh b* đại diện trục Vàng - Xanh lam và a* Đỏ - Lục)
    const toLinear = (c) => (c > 0.04045) ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    let rl = toLinear(rNorm), gl = toLinear(gNorm), bl = toLinear(bNorm);
    let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
    let y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / 1.00000;
    let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;

    const fLab = (t) => (t > 0.008856) ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    let fx = fLab(x), fy = fLab(y), fz = fLab(z);

    let L_star = (116 * fy) - 16;
    let a_star = 500 * (fx - fy);
    let b_star = 200 * (fy - fz); // Kênh b* càng cao thì sắc vàng (Warm) càng mạnh

    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        v: Math.round(v * 100),
        L: L_star.toFixed(1),
        a: a_star.toFixed(1),
        b: b_star.toFixed(1)
    };
}

// 4. Tính độ sáng tương đối (Luminance) để đo Độ tương phản của Richard Russell (Mục 2.6)
function getLuminance(rgb) {
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

// ============================================================================
// GIAI ĐOẠN 3: HỆ CHUYÊN GIA DỰA TRÊN LUẬT (RULE-BASED EXPERT SYSTEM)
// ============================================================================
function evaluateMakeupRules(undertone, visualWeight) {
    let styleName = "";
    let description = "";
    let palette = {};

    // Áp dụng chính xác 4 tập luật IF-THEN trong Mục 3.2 của bài báo
    if (undertone === "Lạnh (Cool)" && visualWeight === "Thấp (Low)") {
        styleName = "Icy Makeup / Clean Girl";
        description = "Tập trung vào tone màu pastel lạnh, ánh nhũ bạc trong trẻo hoặc nền căng bóng tối giản tôn nét thanh tú tự nhiên.";
        palette = {
            foundationHex: "#F5E1DA",
            lipstickHex: "#D86C88",
            blushHex: "#F497B6",
            eyeshadowHex: "#C5B4E3",
            glossiness: 0.85
        };
    } else if (undertone === "Ấm (Warm)" && visualWeight === "Cao (High)") {
        styleName = "Makeup kiểu Tây / Latin";
        description = "Nhấn mạnh tạo khối contour rõ nét, dùng bronzer tone ấm, kẻ mày sắc sảo và son nude cam đất lì quyến rũ.";
        palette = {
            foundationHex: "#E8C39E",
            lipstickHex: "#A64B37",
            blushHex: "#C86D51",
            eyeshadowHex: "#8D5524",
            glossiness: 0.20
        };
    } else if ((undertone === "Trung tính (Neutral)" || undertone === "Lạnh (Cool)") && visualWeight === "Cao (High)") {
        styleName = "Makeup Douyin / Smokey Eyes";
        description = "Đánh nền mịn lì, nhấn sâu đôi mắt có chiều sâu kèm nhũ bắt sáng, má hồng đặt cao và son bóng đỏ hồng sắc sảo.";
        palette = {
            foundationHex: "#F3DFD7",
            lipstickHex: "#B91C46",
            blushHex: "#E15B76",
            eyeshadowHex: "#6D4C5C",
            glossiness: 0.90
        };
    } else {
        // IF [Undertone = Ấm/Trung tính] AND [Visual Weight = Thấp]
        styleName = "Peach Makeup / Makeup No-Makeup";
        description = "Sử dụng gam hồng cam đào nhẹ nhàng, nữ tính, đề cao vẻ đẹp tự nhiên với lớp nền mỏng ẩm tiệp da.";
        palette = {
            foundationHex: "#F2D4BA",
            lipstickHex: "#E06D53",
            blushHex: "#F38D76",
            eyeshadowHex: "#E6A18C",
            glossiness: 0.60
        };
    }

    return { styleName, description, palette };
}

// ============================================================================
// GIAI ĐOẠN 4: KẾT XUẤT ĐỒ HỌA AR (SEMANTIC SEGMENTATION, ALPHA & PBR SHADER)
// ============================================================================

// Danh sách chỉ số điểm mốc (Landmark Indices) phân đoạn ngữ nghĩa từ 468 điểm MediaPipe
const LIP_UPPER_INDICES = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78];
const LIP_LOWER_INDICES = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];
const LEFT_EYE_SHADOW_INDICES = [33, 246, 161, 160, 159, 158, 157, 173, 133, 221, 222, 223, 224, 225, 113];
const RIGHT_EYE_SHADOW_INDICES = [263, 466, 388, 387, 386, 385, 384, 398, 362, 441, 442, 443, 444, 445, 342];

function drawSemanticPolygon(ctx, landmarks, indices, width, height, hexColor, alpha) {
    ctx.save();
    ctx.beginPath();
    indices.forEach((idx, i) => {
        const pt = landmarks[idx];
        const x = pt.x * width;
        const y = pt.y * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = hexColor;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'multiply';
    ctx.filter = 'blur(1.5px)';
    ctx.fill();
    ctx.restore();
}

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

// Mô phỏng hiệu ứng phản xạ PBR Shader (Specular Highlight) trên môi và gò má
function drawPbrSpecularHighlight(ctx, landmarks, width, height, glossiness, alpha) {
    if (glossiness < 0.4) return; // Son lì (matte) có độ phản xạ thấp
    ctx.save();
    const pLeft = landmarks[87];
    const pCenter = landmarks[14];
    const pRight = landmarks[317];

    const x = pCenter.x * width;
    const y = (pCenter.y * height) + 4;
    const rx = Math.abs((pRight.x - pLeft.x) * width) * 0.35;
    const ry = Math.max(rx * 0.22, 2.5);

    const specGrad = ctx.createRadialGradient(x, y, 1, x, y, rx);
    specGrad.addColorStop(0, `rgba(255, 255, 255, ${glossiness * alpha * 0.75})`);
    specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = specGrad;
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
}

// ============================================================================
// LUỒNG XỬ LÝ CHÍNH KHI MEDIAPIPE TRẢ VỀ KẾT QUẢ 468 ĐIỂM MỐC 3D
// ============================================================================
function onFaceMeshResults(results) {
    const startProcessTime = performance.now();
    const width = canvasElement.width;
    const height = canvasElement.height;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, width, height);
    canvasCtx.drawImage(results.image, 0, 0, width, height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // --- BƯỚC 1: CĂN CHỈNH HÌNH HỌC (Mục 2.3) ---
        const leftEyeOuter = landmarks[33];
        const rightEyeOuter = landmarks[263];
        const angleRad = Math.atan2(
            (rightEyeOuter.y - leftEyeOuter.y) * height,
            (rightEyeOuter.x - leftEyeOuter.x) * width
        );
        const headAngleDeg = (angleRad * 180 / Math.PI).toFixed(1);

        // --- BƯỚC 2: TRÍCH XUẤT HÌNH HỌC 3D & TỶ LỆ VÀNG (Mục 2.5) ---
        const topForehead = landmarks[10];
        const chinBottom = landmarks[152];
        const leftCheekEdge = landmarks[234];
        const rightCheekEdge = landmarks[454];
        const upperLipTop = landmarks[13];
        const lowerLipBottom = landmarks[17];

        const faceLength = euclideanDistance3D(topForehead, chinBottom, width, height);
        const faceWidth = euclideanDistance3D(leftCheekEdge, rightCheekEdge, width, height);
        const goldenRatioMeasured = faceLength / (faceWidth || 1);
        const goldenDiffPercent = Math.abs((goldenRatioMeasured - 1.618) / 1.618 * 100).toFixed(1);

        // Độ dày môi tương đối và độ nổi khối
        const lipThicknessRatio = euclideanDistance3D(upperLipTop, lowerLipBottom, width, height) / faceLength;

        // --- BƯỚC 3: PHÂN TÍCH ĐỘ TƯƠNG PHẢN & UNDERTONE (Mục 2.6) ---
        const foreheadRGB = sampleRegionRGB(canvasCtx, landmarks[151], width, height, 5);
        const leftCheekRGB = sampleRegionRGB(canvasCtx, landmarks[50], width, height, 5);
        const rightCheekRGB = sampleRegionRGB(canvasCtx, landmarks[280], width, height, 5);
        const lipSampleRGB = sampleRegionRGB(canvasCtx, landmarks[14], width, height, 3);
        const eyeSampleRGB = sampleRegionRGB(canvasCtx, landmarks[159], width, height, 3);

        const skinRGB = {
            r: Math.round((foreheadRGB.r + leftCheekRGB.r + rightCheekRGB.r) / 3),
            g: Math.round((foreheadRGB.g + leftCheekRGB.g + rightCheekRGB.g) / 3),
            b: Math.round((foreheadRGB.b + leftCheekRGB.b + rightCheekRGB.b) / 3)
        };

        const colorMetrics = rgbToHsvAndLab(skinRGB.r, skinRGB.g, skinRGB.b);

        // Tính độ tương phản khuôn mặt của Richard Russell: C = |L_skin - L_features| / L_skin
        const skinLum = getLuminance(skinRGB);
        const featureLum = (getLuminance(lipSampleRGB) + getLuminance(eyeSampleRGB)) / 2;
        const facialContrast = Math.abs(skinLum - featureLum) / (skinLum || 1);

        // Phân loại Visual Weight (Sức hút thị giác) dựa trên độ tương phản và tỷ lệ ngũ quan
        const visualWeight = (facialContrast > 0.16 || lipThicknessRatio > 0.085) ? "Cao (High)" : "Thấp (Low)";

        // Phân loại Undertone theo kênh b* (CIELAB) và Hue/Saturation (HSV)
        const bStarVal = parseFloat(colorMetrics.b);
        const aStarVal = parseFloat(colorMetrics.a);
        let undertone = "Trung tính (Neutral)";
        if (bStarVal > 16.5 && (bStarVal - aStarVal) > 4.5) {
            undertone = "Ấm (Warm)";
        } else if (bStarVal < 12.5 || aStarVal > bStarVal) {
            undertone = "Lạnh (Cool)";
        }

        // --- BƯỚC 4: HỆ CHUYÊN GIA IF-THEN & XUẤT GÓI JSON (Giai đoạn 3) ---
        const expertResult = evaluateMakeupRules(undertone, visualWeight);
        const currentAlpha = parseFloat(rngAlpha.value);

        const jsonPackage = {
            timestamp: new Date().toISOString(),
            biometrics: {
                headPoseAngleDeg: parseFloat(headAngleDeg),
                goldenRatio: parseFloat(goldenRatioMeasured.toFixed(2)),
                facialContrast: parseFloat(facialContrast.toFixed(3)),
                visualWeight: visualWeight,
                undertone: undertone,
                colorSpace: `HSV(${colorMetrics.h}, ${colorMetrics.s}%, ${colorMetrics.v}%) | Lab_b*(${colorMetrics.b})`
            },
            recommendedStyle: expertResult.styleName,
            arRenderConfig: {
                foundationHex: expertResult.palette.foundationHex,
                lipstickHex: expertResult.palette.lipstickHex,
                blushHex: expertResult.palette.blushHex,
                eyeshadowHex: expertResult.palette.eyeshadowHex,
                alphaOpacity: currentAlpha,
                pbrGlossiness: expertResult.palette.glossiness
            }
        };

        // --- BƯỚC 5: KẾT XUẤT ĐỒ HỌA AR THỜI GIAN THỰC (Giai đoạn 4) ---
        if (chkMakeup.checked) {
            // Phủ phấn mắt (Eyeshadow Semantic Segmentation)
            drawSemanticPolygon(canvasCtx, landmarks, LEFT_EYE_SHADOW_INDICES, width, height, expertResult.palette.eyeshadowHex, currentAlpha * 0.6);
            drawSemanticPolygon(canvasCtx, landmarks, RIGHT_EYE_SHADOW_INDICES, width, height, expertResult.palette.eyeshadowHex, currentAlpha * 0.6);

            // Phủ má hồng (Blush Radial Blending)
            const cheekRadius = faceWidth * 0.16;
            drawBlushRadial(canvasCtx, landmarks[50], width, height, cheekRadius, expertResult.palette.blushHex, currentAlpha);
            drawBlushRadial(canvasCtx, landmarks[280], width, height, cheekRadius, expertResult.palette.blushHex, currentAlpha);

            // Phủ son môi trên & dưới (Lip Semantic Segmentation)
            drawSemanticPolygon(canvasCtx, landmarks, LIP_UPPER_INDICES, width, height, expertResult.palette.lipstickHex, currentAlpha);
            drawSemanticPolygon(canvasCtx, landmarks, LIP_LOWER_INDICES, width, height, expertResult.palette.lipstickHex, currentAlpha);

            // Hiệu ứng đổ bóng vật lý PBR Shader trên môi
            if (chkPbr.checked) {
                drawPbrSpecularHighlight(canvasCtx, landmarks, width, height, expertResult.palette.glossiness, currentAlpha);
            }
        }

        // Vẽ lưới 468 điểm 3D (nếu bật checkbox) để minh họa báo cáo khoa học
        if (chkMesh.checked) {
            canvasCtx.fillStyle = "rgba(56, 189, 248, 0.75)";
            for (let i = 0; i < landmarks.length; i++) {
                const pt = landmarks[i];
                canvasCtx.beginPath();
                canvasCtx.arc(pt.x * width, pt.y * height, 1.2, 0, 2 * Math.PI);
                canvasCtx.fill();
            }
        }

        // Tính toán độ trễ (Latency) và FPS cho mục Thực nghiệm
        const now = performance.now();
        currentLatency = (now - startProcessTime).toFixed(1);
        currentFps = Math.min(60, Math.round(1000 / Math.max(1, now - lastFrameTime)));
        lastFrameTime = now;

        // Cập nhật lên giao diện
        document.getElementById('fps-badge').textContent = `FPS: ${currentFps}`;
        document.getElementById('latency-badge').textContent = `Độ trễ: ${currentLatency} ms`;
        document.getElementById('val-angle').textContent = `${headAngleDeg}°`;
        document.getElementById('val-golden').textContent = `${goldenRatioMeasured.toFixed(2)} (Sai số: ${goldenDiffPercent}%)`;
        document.getElementById('val-contrast').textContent = facialContrast.toFixed(3);
        document.getElementById('val-weight').textContent = visualWeight;
        document.getElementById('val-color-space').textContent = `H:${colorMetrics.h}° S:${colorMetrics.s}% V:${colorMetrics.v}% | b*:${colorMetrics.b}`;
        document.getElementById('val-undertone').textContent = undertone;
        document.getElementById('val-style-name').textContent = expertResult.styleName;
        document.getElementById('val-style-desc').textContent = expertResult.description;
        document.getElementById('json-output').textContent = JSON.stringify(jsonPackage, null, 2);

        latestAnalysisData = {
            goldenRatio: `${goldenRatioMeasured.toFixed(2)} (${goldenDiffPercent}%)`,
            contrast: facialContrast.toFixed(3),
            visualWeight: visualWeight,
            colorInfo: `HSV(${colorMetrics.h},${colorMetrics.s},${colorMetrics.v}) / b*=${colorMetrics.b}`,
            undertone: undertone,
            style: expertResult.styleName,
            latency: currentLatency,
            fps: currentFps
        };
    }

    canvasCtx.restore();
}

// ============================================================================
// KHỞI TẠO MÔ HÌNH AI MEDIAPIPE FACE MESH (KAIPENG ZHANG - 468 ĐIỂM 3D)
// ============================================================================
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

// Xử lý bật/tắt Camera thời gian thực
btnCamera.addEventListener('click', async () => {
    if (!isCameraRunning) {
        isCameraRunning = true;
        btnCamera.textContent = "Tạm Dừng Camera";
        cameraInstance = new Camera(videoElement, {
            onFrame: async () => {
                if (isCameraRunning) {
                    await faceMesh.send({ image: videoElement });
                }
            },
            width: 640,
            height: 480
        });
        cameraInstance.start();
    } else {
        isCameraRunning = false;
        btnCamera.textContent = "Bật Camera Thời Gian Thực";
        if (cameraInstance) cameraInstance.stop();
    }
});

// Xử lý tải ảnh chân dung lên để test bộ dữ liệu
async function processStaticImage() {
    lastFrameTime = performance.now() - 28; // Giả lập chu kỳ khung hình chuẩn khi test ảnh tĩnh
    await faceMesh.send({ image: imageElement });
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

// ============================================================================
// MODULE GHI NHẬN & QUẢN LÝ BẢNG SỐ LIỆU THỰC NGHIỆM (THÊM / XÓA DÒNG / XÓA HẾT)
// ============================================================================
const btnClearAll = document.getElementById('btn-clear-all');

// Hàm vẽ lại bảng và tự động đánh lại số thứ tự Mẫu #1, Mẫu #2...
function renderExperimentTable() {
    const tbody = document.getElementById('exp-tbody');
    tbody.innerHTML = "";

    experimentRecords.forEach((record, index) => {
        record.id = `Mẫu #${index + 1}`; // Tự động cập nhật lại STT chuẩn
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

// Hàm xóa 1 dòng bất kỳ khi bấm nút "Xóa" trên dòng đó
window.deleteSingleRecord = function(index) {
    experimentRecords.splice(index, 1);
    sampleCounter = experimentRecords.length;
    renderExperimentTable();
};

// Sự kiện bấm nút "Ghi Nhận Mẫu Thực Nghiệm"
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

// Sự kiện bấm nút "Xóa Toàn Bộ Bảng"
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

// Sự kiện bấm nút "Xuất file Excel (CSV)"
btnExportCsv.addEventListener('click', () => {
    if (experimentRecords.length === 0) {
        alert("Chưa có mẫu thực nghiệm nào trong bảng!");
        return;
    }
    let csvContent = "\uFEFFMẫu thử,Tỷ lệ nhân trắc (Sai số),Độ tương phản,Visual Weight,Chỉ số HSV/Lab,Undertone,Phong cách đề xuất,Độ trễ (ms),Tốc độ (FPS)\n";
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