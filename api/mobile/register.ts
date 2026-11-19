import { handleMobile } from '../../server/mobile-api';

export default function handler(req: any, res: any) {
  return handleMobile('register', req, res);
}
