import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/isPublic.decorator';
import { WalletResponseDto } from './dto/wallet-response.dto';
import { WalletService } from './wallet.service';

@ApiTags('Wallet')
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Public()
  @Get(':uid')
  @ApiOkResponse({ type: WalletResponseDto, description: 'Wallet balance and transaction history' })
  getWallet(@Param('uid') uid: string) {
    return this.walletService.getWallet(uid);
  }
}
