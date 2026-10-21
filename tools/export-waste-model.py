"""Convert a YOLOv8 classification model (.pt) to ONNX for SmartSort.

Default source: WasteDetector (github.com/xrl3y/WasteDetector, MIT),
weights Recibot/runs/classify/train6/weights/best.pt. Use the same script
for a model retrained on Luther Plastics' own photos.

    pip install ultralytics onnx onnxslim onnxruntime
    python tools/export-waste-model.py path/to/best.pt --imgsz 640 [--check img1.jpg ...]

Writes public/smartsort/models/waste_yolov8n_cls/{model-<imgsz>.onnx, meta.json}.
Only load .pt files you trust: they are Python pickles and can run code.
"""
import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'smartsort' / 'models' / 'waste_yolov8n_cls'

# Class names in WasteDetector's model -> SmartSort general-mode category ids.
CATEGORY = {'metal': 'metal', 'organico': 'organic', 'papel_y_carton': 'paper', 'plastico': 'plastic', 'vidrio': 'glass'}
LABEL = {'metal': 'Metal', 'organico': 'Organic', 'papel_y_carton': 'Paper and cardboard', 'plastico': 'Plastic', 'vidrio': 'Glass'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('weights')
    ap.add_argument('--imgsz', type=int, default=640)  # the size train6 was trained at; smaller sizes misread PET as glass
    ap.add_argument('--version', default='wastedetector-train6')
    ap.add_argument('--check', nargs='*', default=[], help='images to compare PyTorch vs ONNX output on')
    args = ap.parse_args()

    from ultralytics import YOLO
    model = YOLO(args.weights)
    names = [model.names[i] for i in range(len(model.names))]
    unknown = [n for n in names if n not in CATEGORY]
    if unknown:
        raise SystemExit(f'Add these classes to CATEGORY/LABEL first: {unknown}')

    onnx_path = Path(model.export(format='onnx', imgsz=args.imgsz, simplify=True, opset=17, dynamic=False))
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f'model-{args.imgsz}.onnx'
    shutil.copyfile(onnx_path, target)

    meta = {
        'file': target.name,
        'imgsz': args.imgsz,
        'names': names,
        'map': {n: CATEGORY[n] for n in names},
        'labels': {n: LABEL[n] for n in names},
        'version': f'{args.version}@{args.imgsz}',
        'source': 'https://github.com/xrl3y/WasteDetector (MIT)',
    }
    (OUT / 'meta.json').write_text(json.dumps(meta, indent=2))
    print(f'wrote {target} ({target.stat().st_size // 1024} KB) and meta.json')

    if args.check:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
        sess = ort.InferenceSession(str(target), providers=['CPUExecutionProvider'])
        for img in args.check:
            im = Image.open(img).convert('RGB')
            w, h = im.size
            s = min(w, h)
            im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((args.imgsz, args.imgsz), Image.BILINEAR)
            x = (np.asarray(im, dtype=np.float32) / 255).transpose(2, 0, 1)[None]
            p_onnx = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
            p_pt = model.predict(img, imgsz=args.imgsz, verbose=False)[0].probs.data.cpu().numpy()
            top = int(p_onnx.argmax())
            print(f'{Path(img).name:16s} onnx: {names[top]:15s} {p_onnx[top]:.2f}   pytorch: {names[int(p_pt.argmax())]:15s} {p_pt.max():.2f}')


if __name__ == '__main__':
    main()
