"""메뉴바 아이콘(실루엣 슬라임, 눈 뚫림)을 PNG 로 그린다. *Template = 검정(macOS), 나머지 = 흰색(Windows). wait=True 면 오른쪽 위에 말풍선. 의존성 없음. `npm run icon`."""
import struct, sys, zlib

BUBBLE = ((15.3, 2.9), 2.4)  # 말풍선 중심, 반지름
TAIL = ((13.2, 5.9), 0.6)    # 말풍선 꼬리(점)

def dist(x, y, c): return ((x - c[0]) ** 2 + (y - c[1]) ** 2) ** .5

def inside(x, y, wait=False):  # 18x18 좌표계. 바닥 중심 (9,16) 반타원 몸통, 눈 두 개는 뺀다
    body = ((x - 9) / 7.6) ** 2 + ((y - 16) / 13.6) ** 2 <= 1 and y <= 16
    eyes = any(((x - ex) / 1.15) ** 2 + ((y - 9.8) / 1.6) ** 2 <= 1 for ex in (6.5, 11.5))
    if not wait:
        return body and not eyes
    # 말풍선 둘레에 0.8 만큼 틈을 내서 몸통과 붙어 보이지 않게
    gap = dist(x, y, BUBBLE[0]) <= BUBBLE[1] + .8 or dist(x, y, TAIL[0]) <= TAIL[1] + .8
    bubble = dist(x, y, BUBBLE[0]) <= BUBBLE[1] or dist(x, y, TAIL[0]) <= TAIL[1]
    return (body and not eyes and not gap) or bubble

def png(size, path, wait=False, ss=4, rgb=(0, 0, 0)):
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter none
        for px in range(size):
            hits = sum(inside((px + (i + .5) / ss) * 18 / size, (py + (j + .5) / ss) * 18 / size, wait)
                       for i in range(ss) for j in range(ss))
            row += bytes([*rgb, round(255 * hits / (ss * ss))])
        rows.append(bytes(row))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))

png(18, 'src/trayTemplate.png')
png(36, 'src/trayTemplate@2x.png')
png(18, 'src/trayWaitTemplate.png', wait=True)
png(36, 'src/trayWaitTemplate@2x.png', wait=True)
png(18, 'src/tray.png', rgb=(255, 255, 255))
png(36, 'src/tray@2x.png', rgb=(255, 255, 255))
png(18, 'src/trayWait.png', wait=True, rgb=(255, 255, 255))
png(36, 'src/trayWait@2x.png', wait=True, rgb=(255, 255, 255))
assert inside(15.3, 2.9, wait=True) and not inside(15.3, 2.9) and inside(11.5, 8.0, wait=True), 'bubble check'
assert inside(9, 9.8) and inside(9, 12) and not inside(6.5, 9.8) and not inside(1, 3), 'shape check'
print('ok')
