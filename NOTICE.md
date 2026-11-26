# NOTICE

이 저장소는 rhwp(https://github.com/edwardkim/rhwp)를 부품으로 쓴다. rhwp 소스는 저장소에 들어 있지
않고, `scripts/bootstrap.sh` 가 `upstream.lock` 에 적힌 커밋을 받아 `patches/rhwp/*.patch` 를 적용한다.
패치 파일에는 rhwp 소스의 일부(바꾸는 줄과 앞뒤 맥락)가 들어 있으며, 그 부분은 아래 rhwp 라이선스를
따른다. rhwp 가 쓰는 서드파티 구성 요소의 고지는 rhwp 저장소의 `THIRD_PARTY_LICENSES.md` 를 본다.

---

MIT License

Copyright (c) 2025-2026 Edward Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
